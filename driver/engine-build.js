// Building the sweep engine from inside the plugin.
//
// A Lab install carries the engine's source and no binary — the engine links
// against whichever UHD is on the machine, so it has to be compiled there.
// Rather than ask an RF coordinator to open a terminal, the plugin does it:
// when a config push finds no engine and the tools are present, it starts the
// build detached and reports progress as its own status. The host awaits the
// config hook, so nothing here blocks; completion arrives as a status event.
//
//   no engine, tools present   → `connecting`  "Building the sweep engine…"
//                              → `ok`          (binary exists) | `bad-config` (compiler's last lines)
//   no engine, tools missing   → `needs-setup` the install steps for this platform, in order
//   engine, no FPGA images     → `needs-setup` the one command that fetches them
//   "Engine binary" set, absent → `bad-config`  a setting to fix, not something to build over
//
// The two `needs-setup` states are waiting on the user's terminal and clear
// themselves: the plugin re-checks every RETRY_MS while it is in one, so the
// user runs the commands the status names and watches it carry on — brew
// finishes, the build starts; the images land, the status goes ok. Nothing
// asks them to touch a setting to make the plugin look again. A build that
// failed is not retried on the timer (that would spin a compiler every
// fifteen seconds); the timer only watches for a binary the user built by hand,
// and the next config push tries the build again.
//
// A user who would rather not have a plugin compile C++ can set "Engine
// binary" to a build of their own, which short-circuits this before anything
// is spawned.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { PLUGIN_STATUS } from '@soundbase/plugin-contract';
import {
  BUILD_HINT,
  BUILD_SCRIPT,
  IMAGES_SHELL,
  PLUGIN_ROOT,
  engineStatus,
  mockRequested,
} from './locate.js';
import { imagesState, parseImagesDir } from './uhd-images.js';

/** The B206mini-i is not supported before UHD 4.9. */
export const UHD_MIN = [4, 9];

/** How often the plugin looks again while it is waiting on the user's terminal. */
export const RETRY_MS = 15_000;

/** How many lines of build output to keep for the failure message. */
const TAIL_LINES = 12;

export const BUILDING_MESSAGE =
  'Building the sweep engine for this machine — about a minute the first time. ' +
  'Devices appear when it finishes.';

const RETRY_SECONDS = Math.round(RETRY_MS / 1000);

/** How the waiting states end: on their own, with the terminal steps done. */
const KEEP_OPEN =
  `Leave SoundBase open: the plugin checks again every ${RETRY_SECONDS} seconds and carries on by itself ` +
  'as soon as that is done — no setting to change, no restart.';

/**
 * The status for "waiting on the user's machine, not on a setting" — core 1.3,
 * where the host's badge reads "Needs setup". A 1.2 host shows the raw value
 * on the badge, which is why the message still opens by saying what the state
 * is.
 */
export const NEEDS_SETUP = PLUGIN_STATUS.NEEDS_SETUP;

/** The message says what an older host's badge cannot. */
const INCOMPLETE = 'Installation incomplete:';

/** `cmake --version` → "cmake version 4.4.3"; null when not installed or broken. */
function versionOf(command, args = ['--version']) {
  const out = capture(command, args);
  return out === null ? null : out.trim().split('\n').find((l) => l.trim()) ?? '';
}

/** Everything a command printed, or null when it is not installed or failed. */
function capture(command, args) {
  try {
    const r = spawnSync(command, args, { encoding: 'utf8', timeout: 10_000 });
    if (r.error || r.status !== 0) return null;
    return `${r.stdout}${r.stderr}`;
  } catch {
    return null;
  }
}

/**
 * What is installed. `ninja` is only preferred — the build script falls back
 * to CMake's default generator — so it never blocks; cmake and a new enough UHD do.
 */
export function checkTools({ probe = versionOf } = {}) {
  const uhdLine = probe('uhd_config_info');
  const m = /UHD\s+(\d+)\.(\d+)/.exec(uhdLine ?? '');
  const uhd = m
    ? {
        version: `${m[1]}.${m[2]}`,
        ok:
          Number(m[1]) > UHD_MIN[0] ||
          (Number(m[1]) === UHD_MIN[0] && Number(m[2]) >= UHD_MIN[1]),
      }
    : { version: null, ok: false };
  return {
    cmake: probe('cmake') !== null,
    ninja: probe('ninja') !== null,
    uhd,
  };
}

/**
 * Whether UHD, as this process sees it, has the firmware and FPGA images that
 * program a B206mini-i. The engine inherits this environment, so what
 * `uhd_config_info --images-dir` says here is what UHD will find in there.
 * Without the images the radio powers up and is never seen — the one failure
 * in the install flow that would otherwise arrive as "no devices" and no clue.
 *
 * With no uhd_config_info at all the question cannot be asked; that is not a
 * missing image (the tools check owns it), so the answer is "fine".
 */
export function checkImages({ probe = capture, exists = existsSync } = {}) {
  const out = probe('uhd_config_info', ['--images-dir']);
  if (out === null) return { ok: true, dir: '', missing: [] };
  return imagesState(parseImagesDir(out), exists);
}

/**
 * A command the user pastes into a terminal, as a fenced block. SoundBase
 * renders status messages as Markdown and gives a fenced block a Copy button;
 * `indent` nests the block inside a numbered step.
 */
const fenced = (command, indent = '') =>
  [`${indent}\`\`\`sh`, `${indent}${command}`, `${indent}\`\`\``].join('\n');

const STEP_INDENT = '   ';

/**
 * The install steps for this platform, in the order to run them, as a
 * numbered Markdown list with one command to a step. The images step carries
 * its folder because the plugin lives somewhere the user has never looked.
 */
export function prerequisitesMessage(tools, platform = process.platform) {
  const missing = [];
  if (!tools.cmake) missing.push('cmake');
  if (!tools.uhd.ok) {
    missing.push(
      tools.uhd.version
        ? `UHD ${UHD_MIN.join('.')} or newer (installed: ${tools.uhd.version})`
        : `UHD ${UHD_MIN.join('.')} or newer`
    );
  }
  const what = missing.join(' and ');

  let toolsStep;
  let after = '';
  if (platform === 'darwin') {
    // Homebrew ships neither the images nor uhd_images_downloader on PATH.
    toolsStep = [
      '1. Install the build tools:',
      fenced('brew install cmake ninja uhd', STEP_INDENT),
    ];
  } else if (platform === 'linux') {
    toolsStep = [
      '1. Install the build tools:',
      fenced('sudo apt install cmake ninja-build libuhd-dev uhd-host', STEP_INDENT),
    ];
    after = `Distribution packages may be older than ${UHD_MIN.join('.')}; then UHD has to come from Ettus’ PPA or from source.`;
  } else {
    toolsStep = ['1. Install cmake and UHD.'];
  }

  return [
    `${INCOMPLETE} the sweep engine cannot be built yet, because this machine needs ${what}. In a terminal, run these in order:`,
    '',
    ...toolsStep,
    '2. Fetch the USRP firmware and FPGA images UHD needs. Without them no radio is ever found.',
    fenced(IMAGES_SHELL, STEP_INDENT),
    '',
    ...(after ? [after, ''] : []),
    `${KEEP_OPEN} The engine builds itself once the tools are there, with progress shown here.`,
  ].join('\n');
}

/** The engine is fine; UHD has nothing to program the radio with. */
export function imagesMessage(state) {
  const where = state.dir
    ? `UHD’s images folder (${state.dir}) is missing ${state.missing.join(', ')}`
    : 'UHD has no images folder';
  return [
    `${INCOMPLETE} the sweep engine is built, but ${where}, so it cannot program the B206mini-i and no radio will be found. In a terminal, run:`,
    '',
    fenced(IMAGES_SHELL),
    '',
    `That fetches the USRP firmware and FPGA images; run it again after upgrading UHD. ${KEEP_OPEN}`,
  ].join('\n');
}

export function buildFailedMessage(result) {
  const tail = result.tail.slice(-3).join(' / ');
  return (
    `The sweep engine failed to build${tail ? `: ${tail}` : ''}. ` +
    `Change any plugin setting to try again, or for the full output ${BUILD_HINT}.`
  );
}

/**
 * One build at a time, for the whole plugin. Config pushes arrive in bursts
 * (every setting the user touches), and each one asks for the engine; they all
 * get the build already running rather than a second compiler.
 */
export class EngineBuilder {
  #inFlight = null;
  #child = null;

  constructor({
    command = process.execPath,
    args = [BUILD_SCRIPT],
    cwd = PLUGIN_ROOT,
    spawnFn = spawn,
  } = {}) {
    this.command = command;
    this.args = args;
    this.cwd = cwd;
    this.spawnFn = spawnFn;
    /** The last completed build: { ok, code, tail }. */
    this.lastResult = null;
  }

  get building() {
    return this.#inFlight !== null;
  }

  /**
   * Start a build unless one is running; resolves with its result either way.
   * `onDone` is called once per build, not once per caller.
   */
  start(onDone) {
    if (this.#inFlight) return this.#inFlight;
    this.#inFlight = new Promise((resolve) => {
      const tail = [];
      const keep = (chunk) => {
        for (const line of String(chunk).split('\n')) {
          const t = line.trimEnd();
          if (!t) continue;
          tail.push(t);
          if (tail.length > TAIL_LINES) tail.shift();
        }
      };
      const finish = (code, err) => {
        if (err) keep(err.message);
        const result = { ok: code === 0, code, tail };
        this.lastResult = result;
        this.#inFlight = null;
        this.#child = null;
        onDone?.(result);
        resolve(result);
      };
      let child;
      try {
        child = this.spawnFn(this.command, this.args, {
          cwd: this.cwd,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (err) {
        finish(-1, err);
        return;
      }
      this.#child = child;
      child.stdout?.on('data', keep);
      child.stderr?.on('data', keep);
      child.once('error', (err) => finish(-1, err));
      child.once('exit', (code, signal) => finish(code ?? -1, signal ? new Error(`killed by ${signal}`) : null));
      // A compiler outliving SoundBase is a surprise nobody wants to find in
      // Activity Monitor. cmake is incremental, so an interrupted build costs
      // nothing but the interruption.
      process.once('exit', () => child.kill('SIGTERM'));
    });
    return this.#inFlight;
  }
}

const defaultBuilder = new EngineBuilder();

/**
 * The plugin's one pending re-check and the last status it reported. A config
 * push replaces the timer, so bursts of pushes never stack timers; the last
 * report is what lets a timer tick stay silent when nothing has changed — the
 * shell emits an event per report, and a message repeated every fifteen
 * seconds is noise in the host's log.
 */
export function createWatch() {
  return { timer: null, last: null };
}

const defaultWatch = createWatch();

/**
 * Decide what the plugin's status should be, start a build if that is the
 * answer, and arrange to look again if the answer is "waiting on the user".
 * `report(status, message)` is the plugin's updateStatus; it is called
 * synchronously with the current truth and again, later, when a build ends or
 * a re-check finds something changed. Returns what it decided, for tests and
 * logs:
 *
 *   'ok' | 'bad-config' (a setting to fix) | 'building' | 'prerequisites' |
 *   'images' | 'failed' (a timer tick after a failed build; nothing new to say)
 */
export function reconcileEngine(pluginConfig = {}, report, opts = {}) {
  const {
    status = engineStatus,
    tools = checkTools,
    images = checkImages,
    mock = mockRequested,
    builder = defaultBuilder,
    platform = process.platform,
    retryMs = RETRY_MS,
    watch = defaultWatch,
    /** Set on timer ticks: repeat nothing, and never restart a failed build. */
    quiet = false,
  } = opts;

  if (watch.timer) {
    clearTimeout(watch.timer);
    watch.timer = null;
  }
  const again = () => {
    watch.timer = setTimeout(
      () => reconcileEngine(pluginConfig, report, { ...opts, quiet: true }),
      retryMs
    );
    watch.timer.unref?.();
  };
  const say = (s, m) => {
    if (quiet && watch.last && watch.last.status === s && watch.last.message === m) return;
    watch.last = { status: s, message: m };
    report(s, m);
  };

  const now = status(pluginConfig);
  if (now.ok) {
    // The engine is only useful if UHD can program the radio; the fake engine
    // programs nothing.
    if (!mock()) {
      const found = images();
      if (!found.ok) {
        say(NEEDS_SETUP, imagesMessage(found));
        again();
        return 'images';
      }
    }
    say('ok');
    return 'ok';
  }
  // A path the user typed that is not there is theirs to fix; building over it
  // would make the setting silently mean nothing.
  if (String(pluginConfig.enginePath ?? '').trim()) {
    say('bad-config', now.message);
    return 'bad-config';
  }
  if (builder.building) {
    say('connecting', BUILDING_MESSAGE);
    return 'building';
  }
  // After a failed build the timer only watches for a binary built by hand;
  // a config push is the user asking for another go.
  if (quiet && builder.lastResult && !builder.lastResult.ok) {
    again();
    return 'failed';
  }
  const found = tools();
  if (!found.cmake || !found.uhd.ok) {
    say(NEEDS_SETUP, prerequisitesMessage(found, platform));
    again();
    return 'prerequisites';
  }
  say('connecting', BUILDING_MESSAGE);
  builder.start((result) => {
    // The exit code says the script was happy; the binary being there is the
    // thing that matters, so ask the same question the adapter will — and the
    // next one, whether UHD has its images, which the build says nothing about.
    if (result.ok && status(pluginConfig).ok) {
      reconcileEngine(pluginConfig, report, { ...opts, quiet: false });
    } else {
      say('bad-config', buildFailedMessage(result));
      again();
    }
  });
  return 'building';
}
