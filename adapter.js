// The Ettus USRP B206mini-i as a SoundBase spectrum analyzer.
//
// The radio is driven by the C++ sweep engine in engine/ — it owns libuhd, the
// LO plan, the FFTs and the stitching, and it is a separate process precisely
// so that a wedged USB call cannot take this plugin down with it. driver/ is
// the JavaScript half: spawning that process, decoding its frames, and turning
// its grid into the points SoundBase asked for.
//
//   adapter.js          the contract: discovery, configuration, sweeps
//   driver/engine-client.js   the engine process and its Unix socket
//   driver/frames.js          its binary frame format
//   driver/plan.js            geometry: engine cells ↔ SoundBase points
//   driver/fake-engine.js     the same wire, with no radio attached
//
// Read docs/engine-protocol.md for what goes over that socket, and
// docs/adapter-reference.md for what the shell expects back from here.

import { EngineClient } from './driver/engine-client.js';
import { WarningTracker } from './driver/warnings.js';
import { LIVE_KIND_FOR_DETECTOR, liveTrace, maskOf } from './driver/frames.js';
import {
  BUILD_HINT,
  deviceArgsFor,
  findRadios,
  resolveEngineBinary,
} from './driver/locate.js';
import {
  platformSupported,
  unsupportedPlatformMessage,
} from './driver/platform.js';
import {
  ANTENNAS,
  DETECTORS,
  DEVICE_MAX_HZ,
  DEVICE_MIN_HZ,
  DWELLS,
  GAIN_MAX_DB,
  GAIN_MIN_DB,
  MAX_REF_LEVEL_DBM,
  MIN_REF_LEVEL_DBM,
  RBW_PRESETS_HZ,
  USB2_PROFILES,
  USB3_PROFILES,
  VBW_PRESETS_HZ,
  clamp,
  isNum,
  reducerFor,
  resolvePointCount,
  traceToPoints,
} from './driver/plan.js';

/** Declared in soundbase-plugin.json; `npm run rename` keeps the two in step. */
export const PRODUCT = 'plugin:ettus-usrp-b206mini-i/b206mini-i';

/** Enumeration is polled once a second; the USB bus does not change that fast. */
const DISCOVERY_INTERVAL_MS = 2500;

/**
 * Radios this plugin has claimed, by serial.
 *
 * A B200 that an engine has opened does not answer enumeration at all —
 * `engine --find` returns an empty list while a sweep is running — so this is
 * what keeps an in-use radio in the device list. Without it the device would
 * disappear from discovery seconds after it started working, and the shell
 * removes a discovered device it stops being told about.
 */
const openRadios = new Map();

let lastFind = { at: 0, radios: [] };
let findInFlight = null;
let warnedNoEngine = false;
let warnedPlatform = false;

/**
 * The USRPs attached right now.
 *
 * `engine --find` reads USB descriptors and never claims a radio, so it is
 * safe to call while a sweep is running. It also cannot see a radio that is
 * already open — a claimed B200 does not answer enumeration at all — so a
 * radio this plugin has claimed is reported from `openRadios` rather than
 * re-enumerated. That is not an optimisation: without it, every device would
 * disappear from the list seconds after it started working.
 *
 * SoundBase polls this once a second while a device picker is open, so the
 * enumeration itself is cached for a couple of seconds. A machine with no USRP
 * attached returns nothing, which is a normal answer and not worth an error
 * per second.
 */
export async function discoverDevices(pluginConfig = {}) {
  // Said once, not once a second: discovery is polled, and a plugin that logs
  // an error per poll buries the line that matters.
  if (!platformSupported()) {
    if (!warnedPlatform) {
      warnedPlatform = true;
      process.stderr.write(`[usrp] ${unsupportedPlatformMessage()}\n`);
    }
    return [];
  }

  const binPath = resolveEngineBinary(pluginConfig);
  if (!binPath) {
    if (!warnedNoEngine) {
      warnedNoEngine = true;
      process.stderr.write(
        `[usrp] no sweep engine binary: ${BUILD_HINT}. No devices will appear until it exists.\n`
      );
    }
    return [];
  }
  warnedNoEngine = false;

  const radios = await cachedFind(binPath);
  const bySerial = new Map(radios.map((r) => [r.serial, r]));
  for (const [serial, radio] of openRadios) bySerial.set(serial, radio);

  return [...bySerial.values()].map((radio) => ({
    // Stable across restarts because a serial number is: it goes into URLs and
    // into the user's saved project, and has to mean the same radio tomorrow.
    id: `usb:${radio.serial}`,
    name: `${radio.product ?? 'USRP'} (${radio.serial})`,
    product: PRODUCT,
    transport: { kind: 'usb', serial: radio.serial },
  }));
}

async function cachedFind(binPath) {
  const now = Date.now();
  if (now - lastFind.at < DISCOVERY_INTERVAL_MS) return lastFind.radios;
  if (findInFlight) return findInFlight;
  findInFlight = findRadios(binPath)
    .then((radios) => {
      lastFind = { at: Date.now(), radios };
      return radios;
    })
    .finally(() => {
      findInFlight = null;
    });
  return findInFlight;
}

export function createSpectrumAnalyzerAdapter(device, pluginConfig) {
  return new UsrpAnalyzerAdapter(device, pluginConfig);
}

class UsrpAnalyzerAdapter {
  /** Assigned by the shell; called when the engine dies unprompted. */
  onFatal = null;
  /**
   * Assigned by a shell that implements core 1.1; called with the complete
   * current set of warnings whenever it changes. An older shell leaves it
   * unassigned and the radio's conditions simply go unreported.
   */
  onWarnings = null;

  constructor(device, pluginConfig = {}) {
    this.device = device;
    this.pluginConfig = pluginConfig ?? {};
    // Addressing arrives explicitly, never from a file beside the plugin: the
    // same project opened on another machine has to reach the same radio.
    this.serial = serialOf(device);
    this.offsetDb = isNum(this.pluginConfig.levelOffsetDb)
      ? this.pluginConfig.levelOffsetDb
      : 0;
    this.engine = null;
    this.sweeping = false;
    this.onTrace = null;
    /** What the engine last said it was doing — the source of every echo. */
    this.plan = null;
    /** The geometry the shell is drawing, which sweeps are resampled onto. */
    this.geometry = null;
    this.detector = 'rms';
    this.controls = null;
    this.capabilities = null;
    this.warnings = new WarningTracker();
    this.publishedWarnings = '[]';
  }

  /**
   * Start the engine and report what this radio can do.
   *
   * Everything SoundBase will let the user ask for is bounded by what comes
   * back from here, so the limits are read from the unit that just answered —
   * a B200 on a USB 2 port genuinely cannot run the USB 3 profiles, and saying
   * otherwise produces a setting that fails at sweep time instead of a setting
   * that is simply not offered.
   */
  async open() {
    // A device added by hand reaches open() without going through discovery,
    // so the platform check belongs on both paths. Throwing here is what puts
    // the reason in the device's status, where the user will see it.
    if (!platformSupported()) throw new Error(unsupportedPlatformMessage());

    const binPath = resolveEngineBinary(this.pluginConfig);
    if (!binPath) {
      throw new Error(`The sweep engine is not built: ${BUILD_HINT}.`);
    }
    // Claim the radio *before* spawning the engine, not after it answers.
    // The engine takes the device away from enumeration the moment it opens
    // it, and the shell removes a discovered device that discovery stops
    // reporting and that has no adapter yet — which is exactly what this
    // device is until open() returns. Miss that window and the device vanishes
    // mid-open, and the next request 404s.
    if (this.serial) {
      openRadios.set(this.serial, { serial: this.serial, product: 'USRP' });
    }
    try {
      return await this.#open(binPath);
    } catch (err) {
      // The radio is not ours after all: let discovery tell the truth about it.
      openRadios.delete(this.serial);
      throw err;
    }
  }

  async #open(binPath) {
    const engine = new EngineClient({
      binPath,
      deviceArgs: deviceArgsFor(this.serial),
      tag: this.serial || 'usrp',
      log: ({ level, msg }) => {
        if (level === 'info') return;
        process.stderr.write(`[usrp ${this.serial ?? '?'}] ${msg}\n`);
      },
    });
    engine.onFatal = (err) => {
      this.sweeping = false;
      openRadios.delete(this.serial);
      this.onFatal?.(err);
    };
    engine.onSweep = (frame) => this.#onSweep(frame);
    engine.onStatus = (status) => {
      this.warnings.onStatus(status);
      this.#publishWarnings();
    };
    // Held from here rather than after start() resolves, so a close() that
    // arrives while the engine is still coming up still stops it. Otherwise a
    // device added and removed inside those few seconds leaves an engine
    // holding the radio for the rest of the plugin's life.
    this.engine = engine;

    const status = await engine.start();
    this.plan = status.plan ?? null;

    const info = status.device ?? {};
    if (info.serial) {
      // A device configured with a blank serial ("the only USRP attached")
      // learns which radio it got here, so the claim moves to the real one.
      if (this.serial && this.serial !== info.serial) {
        openRadios.delete(this.serial);
      }
      this.serial = info.serial;
      openRadios.set(info.serial, {
        serial: info.serial,
        product: info.product ?? 'USRP',
      });
    }
    const maxGainDb = Math.min(
      GAIN_MAX_DB,
      Math.round(info.gainRange?.[1] ?? GAIN_MAX_DB)
    );
    const profiles =
      (info.usbVersion ?? 3) >= 3
        ? [...USB3_PROFILES, ...USB2_PROFILES]
        : [...USB2_PROFILES];

    this.controls = {
      gainMode: this.plan?.gainMode ?? 'auto',
      gainDb: this.plan?.gainDb ?? 50,
      dwell: this.plan?.dwell ?? 'coordination',
      detector: this.plan?.detector ?? 'rms',
      antenna: this.plan?.antenna ?? 'RX2',
      profile: 'auto',
    };
    this.detector = this.controls.detector;

    this.capabilities = {
      minFrequencyHz: DEVICE_MIN_HZ,
      maxFrequencyHz: DEVICE_MAX_HZ,
      rbwHz: [...RBW_PRESETS_HZ],
      vbwHz: [...VBW_PRESETS_HZ],
      // Auto gain is set from the reference level as g = −refLevel, so the
      // usable reference levels are exactly those that map onto a legal gain.
      minRefLevelDbm: MIN_REF_LEVEL_DBM,
      maxRefLevelDbm: MAX_REF_LEVEL_DBM,
      // The acquisition grid is min(25 kHz, RBW); asking for points closer
      // together than that does not buy any more resolution.
      minStepHz: Math.min(...RBW_PRESETS_HZ),
      maxStepHz: 10e6,
      controls: [
        {
          id: 'gainMode',
          type: 'dropdown',
          label: 'Gain',
          default: 'auto',
          choices: [
            { id: 'auto', label: 'Auto (from reference level)' },
            { id: 'manual', label: 'Manual' },
          ],
          help: 'Auto backs the gain off to keep the reference level from clipping the front end.',
        },
        {
          id: 'gainDb',
          type: 'number',
          label: 'RX gain',
          unit: 'dB',
          default: this.controls.gainDb,
          min: GAIN_MIN_DB,
          max: maxGainDb,
          step: 1,
          help: 'Used when gain is set to manual.',
        },
        {
          id: 'dwell',
          type: 'dropdown',
          label: 'Dwell',
          default: 'coordination',
          choices: [
            { id: 'fast', label: 'Fast — fastest sweep, noisiest trace' },
            { id: 'coordination', label: 'Coordination — the usual choice' },
            { id: 'hq', label: 'High quality — slowest, steadiest trace' },
          ],
        },
        {
          id: 'detector',
          type: 'dropdown',
          label: 'Detector',
          default: 'rms',
          choices: [
            { id: 'rms', label: 'RMS average' },
            { id: 'peak', label: 'Positive peak' },
            { id: 'sample', label: 'Sample' },
            { id: 'min', label: 'Negative peak' },
          ],
        },
        {
          id: 'antenna',
          type: 'dropdown',
          label: 'Antenna port',
          default: 'RX2',
          choices: ANTENNAS.map((id) => ({ id, label: id })),
        },
        {
          id: 'profile',
          type: 'dropdown',
          label: 'Acquisition profile',
          default: 'auto',
          choices: [
            { id: 'auto', label: `Auto (USB ${info.usbVersion ?? '?'})` },
            ...profiles.map((id) => ({ id, label: id })),
          ],
          help: 'Sample rate and sub-window layout. Auto picks from the USB link speed.',
        },
      ],
    };

    const firmware = [
      info.fw && `fw ${info.fw}`,
      info.fpga && `fpga ${info.fpga}`,
    ]
      .filter(Boolean)
      .join(' / ');

    return {
      capabilities: this.capabilities,
      identity: {
        manufacturer: 'Ettus Research',
        model: info.product ? `USRP ${info.product}` : 'USRP B200-series',
        serialNumber: info.serial ?? this.serial ?? '',
        firmware: firmware || 'unknown',
      },
    };
  }

  /**
   * Send what was asked for and echo what the radio settled on.
   *
   * `cfg` is a patch: an absent field means "leave it alone". Nothing is
   * rejected — a value outside what the hardware can do is snapped to what it
   * can, because a 400 makes a working plugin look broken while a clamped value
   * tells the user what the radio actually did.
   *
   * The engine answers every plan with its own quantisation (the span snapped
   * onto the output grid, the RBW it can really realise, the gain it settled
   * on), so the echo is built from that answer rather than from the request.
   */
  async applyConfig(cfg = {}) {
    if (!this.engine) throw new Error('the sweep engine is not running');
    const previous = this.plan ?? {};
    const plan = {};

    if (isNum(cfg.startHz) || isNum(cfg.stopHz)) {
      const startHz = clamp(
        isNum(cfg.startHz) ? cfg.startHz : previous.startHz,
        DEVICE_MIN_HZ,
        DEVICE_MAX_HZ
      );
      const stopHz = clamp(
        isNum(cfg.stopHz) ? cfg.stopHz : previous.stopHz,
        startHz + 1,
        DEVICE_MAX_HZ
      );
      plan.startHz = startHz;
      plan.stopHz = stopHz;
    }
    if (isNum(cfg.rbwHz)) {
      plan.rbwHz = clamp(
        cfg.rbwHz,
        Math.min(...RBW_PRESETS_HZ),
        Math.max(...RBW_PRESETS_HZ)
      );
    }
    if (isNum(cfg.vbwHz)) {
      plan.vbwHz = clamp(
        cfg.vbwHz,
        Math.min(...VBW_PRESETS_HZ),
        Math.max(...VBW_PRESETS_HZ)
      );
    }
    if (isNum(cfg.refLevelDbm)) {
      plan.refLevelDbm = clamp(
        cfg.refLevelDbm,
        MIN_REF_LEVEL_DBM,
        MAX_REF_LEVEL_DBM
      );
    }
    Object.assign(plan, this.#controlPlan(cfg.controls));

    // An empty patch still has to answer with the effective configuration, and
    // asking the engine costs one round trip — so ask, and echo its reply.
    const reply = await this.engine.setPlan(plan);
    const applied = reply?.applied ?? {};
    this.plan = { ...(this.plan ?? {}), ...applied };
    this.detector = this.plan.detector ?? 'rms';

    const grid = {
      startHz: applied.startHz,
      stopHz: applied.stopHz,
      stepHz: applied.stepHz,
      binCount: applied.binCount,
    };
    const pointCount = resolvePointCount(cfg, grid, this.geometry?.pointCount);
    this.geometry = {
      startHz: grid.startHz,
      stopHz: grid.stopHz,
      stepHz: grid.stepHz,
      binCount: grid.binCount,
      pointCount,
      reducer: reducerFor(this.detector),
    };

    const effective = {
      startHz: grid.startHz,
      stopHz: grid.stopHz,
      pointCount,
      controls: {
        gainMode: this.plan.gainMode,
        gainDb: this.plan.gainDb,
        dwell: this.plan.dwell,
        detector: this.plan.detector,
        antenna: this.plan.antenna,
        profile: this.controls.profile,
      },
    };
    // A request that named an RBW gets the realised one back; a request that
    // left it alone keeps showing "auto" in the form, with what auto meant
    // reported beside it.
    if (isNum(cfg.rbwHz)) effective.rbwHz = this.plan.rbwHz;
    else effective.resolved = { rbwHz: this.plan.rbwHz };

    this.controls = { ...this.controls, ...effective.controls };
    return effective;
  }

  /** Controls, clamped to what the engine accepts. Absent means unchanged. */
  #controlPlan(controls) {
    if (!controls || typeof controls !== 'object') return {};
    const plan = {};
    const pick = (value, allowed) =>
      typeof value === 'string' && allowed.includes(value) ? value : undefined;

    const gainMode = pick(controls.gainMode, ['auto', 'manual']);
    if (gainMode) plan.gainMode = gainMode;
    if (isNum(controls.gainDb)) {
      plan.gainDb = Math.round(clamp(controls.gainDb, GAIN_MIN_DB, GAIN_MAX_DB));
    }
    const dwell = pick(controls.dwell, DWELLS);
    if (dwell) plan.dwell = dwell;
    const detector = pick(controls.detector, DETECTORS);
    if (detector) plan.detector = detector;
    const antenna = pick(controls.antenna, ANTENNAS);
    if (antenna) plan.antenna = antenna;
    const profile = pick(controls.profile, [
      'auto',
      ...USB2_PROFILES,
      ...USB3_PROFILES,
    ]);
    if (profile) {
      plan.profile = profile;
      this.controls.profile = profile;
    }
    return plan;
  }

  /**
   * Sweep continuously. The engine already runs a free-running sweep loop, so
   * this is a command and a callback rather than a read loop — every completed
   * sweep arrives on the socket whether anyone is polling or not, which is what
   * lets the shell accumulate max-hold without missing a transient.
   */
  async startSweep(onTrace) {
    if (!this.engine) throw new Error('the sweep engine is not running');
    this.onTrace = onTrace;
    if (this.sweeping) return;
    this.sweeping = true;
    this.warnings.setSweeping(true);
    this.engine.send({ cmd: 'start' });
  }

  async stopSweep() {
    this.sweeping = false;
    this.warnings.setSweeping(false);
    this.engine?.send({ cmd: 'stop' });
    this.#publishWarnings();
  }

  async close() {
    this.sweeping = false;
    this.onTrace = null;
    openRadios.delete(this.serial);
    const engine = this.engine;
    this.engine = null;
    await engine?.stop();
  }

  /**
   * One completed sweep, in dBm, on the points the shell is drawing.
   *
   * A plan change takes effect at the engine's next sweep boundary, so a frame
   * already in flight can still carry the old grid. Resampling that onto the
   * new axis would draw a spectrum from the wrong frequencies, so it is dropped
   * instead — the next sweep is at most a few hundred milliseconds away.
   */
  #onSweep(frame) {
    this.warnings.onSweep();
    if (!this.sweeping || !this.onTrace || !this.geometry) return;
    if (!sameGrid(frame, this.geometry)) return;
    const trace = liveTrace(frame, this.detector);
    if (!trace) return;
    const points = traceToPoints(
      frame,
      trace,
      maskOf(frame),
      this.geometry,
      this.offsetDb
    );
    if (points) this.onTrace(points);
  }

  /**
   * Hand the shell the radio's current conditions, if they changed. The shell
   * diffs too, but the engine reports once a second and most seconds nothing
   * has changed, so the cheap check happens here first.
   */
  #publishWarnings() {
    if (!this.onWarnings) return;
    const list = this.warnings.current();
    const key = JSON.stringify(list.map((w) => [w.id, w.severity, w.message]));
    if (key === this.publishedWarnings) return;
    this.publishedWarnings = key;
    this.onWarnings(list);
  }
}

/** True when a frame was measured on the grid the current configuration means. */
function sameGrid(frame, geometry) {
  return (
    frame.binCount === geometry.binCount &&
    Math.abs(frame.startHz - geometry.startHz) < 1 &&
    Math.abs(frame.stepHz - geometry.stepHz) < 1e-6
  );
}

/**
 * Which radio this device is. `device.config` holds the manifest's
 * deviceConfigFields, filled in from the SoundBase project; the id fallback
 * covers a device this plugin discovered itself, whose id already carries the
 * serial. An empty serial means "the only USRP attached", which is what a user
 * with one radio should not have to type in.
 */
function serialOf(device) {
  const configured = String(device?.config?.serial ?? '').trim();
  if (configured) return configured;
  const match = /^usb:(.+)$/.exec(device?.id ?? '');
  return match ? match[1] : '';
}
