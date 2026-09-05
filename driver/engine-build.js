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
//   no engine, tools missing   → `bad-config`  the one install command for this platform
//   "Engine binary" set, absent → `bad-config`  a setting to fix, not something to build over
//
// A user who would rather not have a plugin compile C++ can set "Engine
// binary" to a build of their own or tick "Simulate a radio"; both short-circuit
// this before anything is spawned.

import { spawn, spawnSync } from 'node:child_process';
import { BUILD_HINT, BUILD_SCRIPT, PLUGIN_ROOT, engineStatus } from './locate.js';

/** The B206mini-i is not supported before UHD 4.9. */
export const UHD_MIN = [4, 9];

/** How many lines of build output to keep for the failure message. */
const TAIL_LINES = 12;

export const BUILDING_MESSAGE =
  'Building the sweep engine for this machine — about a minute the first time. ' +
  'Devices appear when it finishes.';

/** `cmake --version` → "cmake version 4.4.3"; null when not installed or broken. */
function versionOf(command, args = ['--version']) {
  try {
    const r = spawnSync(command, args, { encoding: 'utf8', timeout: 10_000 });
    if (r.error || r.status !== 0) return null;
    return `${r.stdout}${r.stderr}`.trim().split('\n').find((l) => l.trim()) ?? '';
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

/** The one command that installs what is missing, for this platform. */
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
  let install;
  if (platform === 'darwin') {
    install =
      'brew install cmake ninja uhd, then uhd_images_downloader -t b2xx once';
  } else if (platform === 'linux') {
    install =
      'sudo apt install cmake ninja-build libuhd-dev uhd-host, then uhd_images_downloader -t b2xx once. ' +
      `Distribution packages may be older than ${UHD_MIN.join('.')}; then UHD has to come from Ettus’ PPA or from source`;
  } else {
    install = 'install cmake and UHD';
  }
  return (
    `The sweep engine cannot be built yet: this machine needs ${what}. ` +
    `In a terminal: ${install}. The plugin builds the engine itself once they are there ` +
    '(change any plugin setting to make it look again), or tick "Simulate a radio" to try it without hardware.'
  );
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
 * Decide what the plugin's status should be, and start a build if that is the
 * answer. `report(status, message)` is the plugin's updateStatus; it is called
 * synchronously with the current truth and again, later, when a build ends.
 * Returns what it decided, for tests and logs.
 */
export function reconcileEngine(
  pluginConfig = {},
  report,
  {
    status = engineStatus,
    tools = checkTools,
    builder = defaultBuilder,
    platform = process.platform,
  } = {}
) {
  const now = status(pluginConfig);
  if (now.ok) {
    report('ok');
    return 'ok';
  }
  // A path the user typed that is not there is theirs to fix; building over it
  // would make the setting silently mean nothing.
  if (String(pluginConfig.enginePath ?? '').trim()) {
    report('bad-config', now.message);
    return 'bad-config';
  }
  if (builder.building) {
    report('connecting', BUILDING_MESSAGE);
    return 'building';
  }
  const found = tools();
  if (!found.cmake || !found.uhd.ok) {
    report('bad-config', prerequisitesMessage(found, platform));
    return 'prerequisites';
  }
  report('connecting', BUILDING_MESSAGE);
  builder.start((result) => {
    // The exit code says the script was happy; the binary being there is the
    // thing that matters, so ask the same question the adapter will.
    if (result.ok && status(pluginConfig).ok) report('ok');
    else report('bad-config', buildFailedMessage(result));
  });
  return 'building';
}
