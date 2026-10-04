#!/usr/bin/env node
// A stand-in for the C++ engine, on the same wire.
//
// It takes the same command line, connects to the same Unix socket, speaks the
// same frames and answers the same commands — so the adapter, the driver, the
// supervision path and the shell are all exercised for real, with only the
// radio swapped out. That is what lets the contract tests run on a laptop with
// nothing attached, and what this environment variable turns on when you want
// to poke at the plugin by hand:
//
//   SB_USRP_MOCK=1 npm start
//
// What it does not model: RBW realisation (it echoes what you asked for),
// LO-hop timing (sweeps arrive at a fixed rate, whatever it predicts), gain
// settling and calibration. Levels are a plausible UHF
// scene, not a measurement of anything.

import net from 'node:net';
import {
  Detector,
  Flags,
  MaskBit,
  MsgType,
  TraceKind,
  encodeFrame,
  lengthPrefixed,
} from './frames.js';
import { GRID_MAX_STEP_HZ, snapToGrid } from './plan.js';

const SWEEP_MS = Number(process.env.SB_USRP_MOCK_SWEEP_MS) || 60;
const STATUS_MS = 1000;
const FLOOR_DBM = -105;
/** A plausible UHF scene: DTV, its pilot, and a handful of carriers. */
const SCENE = [
  { hz: 494.325e6, levelDbm: -60, halfWidthHz: 0 },
  { hz: 503e6, levelDbm: -55, halfWidthHz: 3e6 },
  { hz: 500.309e6, levelDbm: -44, halfWidthHz: 0 },
  { hz: 518.7e6, levelDbm: -80, halfWidthHz: 0 },
  { hz: 566.05e6, levelDbm: -45, halfWidthHz: 0 },
  { hz: 590.5e6, levelDbm: -70, halfWidthHz: 0 },
];
/** A rehearsal-room transmitter that keys up briefly: one sweep in seven. */
const TRANSIENT = { hz: 542.1e6, levelDbm: -52, everyNth: 7 };
/** Internal spurs the engine masks out and interpolates across. */
const SPURS_HZ = [480e6, 512e6, 544e6, 576e6, 608e6];
/** What one of them reads when the plan turns the masking off. */
const SPUR_DBM = -85;
/** Fewest spectra a sub-window averages, by dwell: the engine's 0 / 10 / 25 / 100 ms. */
const DWELL_MIN_AVERAGES = { fast: 1, coordination: 31, hq: 78, long: 312 };
/** One LO position's kept bandwidth and dead time, as on usb3-56. */
const HOP_HZ = 48e6;
const HOP_DEAD_MS = 7;

const DEFAULT_PLAN = {
  startHz: 470e6,
  stopHz: 608e6,
  rbwHz: 25e3,
  vbwHz: 2.5e3,
  dwell: 'coordination',
  gainMode: 'auto',
  gainDb: 50,
  refLevelDbm: -50,
  profile: 'auto',
  detector: 'rms',
  antenna: 'RX2',
  interleave: false,
  imageReject: false,
  spurMask: true,
  mode: 'continuous',
  window: 'bh4',
  analogBwHz: 0,
  loGridOffsetHz: 0,
};

const DEVICE = {
  serial: process.env.SB_USRP_MOCK_SERIAL || 'FAKE001',
  product: 'B206mini',
  name: 'B206i',
  type: 'b200',
};

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
};

if (argv.includes('--find')) {
  // A real B200 that an engine has opened does not answer enumeration at all,
  // which is the reason the adapter keeps its own list of claimed radios. This
  // knob reproduces that, so the test for it is a test of something real.
  const claimed = process.env.SB_USRP_MOCK_FIND_EMPTY === '1';
  process.stdout.write(`${JSON.stringify(claimed ? [] : [DEVICE])}\n`);
  process.exit(0);
}

const socketPath = flag('--socket');
if (!socketPath) {
  process.stderr.write('fake-engine: --socket PATH is required\n');
  process.exit(2);
}

// ---------------------------------------------------------------------------

// The gap between the engine's two startup announcements (see 'connect').
const SECOND_ANNOUNCEMENT_MS = Number(process.env.SB_USRP_MOCK_ANNOUNCE_MS ?? 40);

let plan = { ...DEFAULT_PLAN };
let grid = snapToGrid(plan.startHz, plan.stopHz, plan.rbwHz);
/** Plans that arrived before the second startup announcement; applied after it. */
let startingUp = true;
let earlyPlans = [];
let sweeping = false;
let sweepId = 0;
let seq = 0;
let overflows = 0;
let sweepTimer = null;
const startedAt = Date.now();

const gainFor = (p) =>
  p.gainMode === 'manual'
    ? Math.min(76, Math.max(0, Math.round(p.gainDb)))
    : Math.min(60, Math.max(0, Math.round(-p.refLevelDbm)));

const socket = net.createConnection(socketPath);
socket.on('error', (err) => {
  process.stderr.write(`fake-engine: socket error: ${err.message}\n`);
  process.exit(3);
});
socket.on('close', () => process.exit(0));

socket.on('connect', () => {
  // A crash on demand, so the tests can prove that a radio dying mid-sweep
  // fails one device instead of taking the plugin down with it.
  const dieAfterMs = Number(process.env.SB_USRP_MOCK_DIE_AFTER_MS);
  if (dieAfterMs > 0) {
    const timer = setTimeout(() => process.exit(9), dieAfterMs);
    timer.unref?.();
  }
  // The real engine's first moments, in the order they happen. It applies its
  // default plan and announces it — an `applied` nobody asked for, then the
  // first status. It then applies the plan its own command line carried
  // (`--profile auto`), which changes nothing and is announced all the same.
  // On a real radio the two are about a millisecond apart, and a plan sent on
  // the first status lands in between as often as not; it is applied after the
  // second announcement and answered with an `applied` of its own. A client
  // that matches replies to plans by order alone takes the second announcement
  // as its answer. The gap is stretched here so that happens every time.
  announce();
  const second = setTimeout(() => {
    announce();
    startingUp = false;
    const queued = earlyPlans;
    earlyPlans = [];
    if (queued.length) applyPlan(Object.assign({}, ...queued));
  }, SECOND_ANNOUNCEMENT_MS);
  second.unref?.();
  const statusTimer = setInterval(emitStatus, STATUS_MS);
  statusTimer.unref?.();
});

/** An `applied` for the plan already in force, and the status that follows it. */
function announce() {
  send({
    msgType: MsgType.Status,
    profileId: 7,
    json: { type: 'applied', requested: { ...plan }, applied: appliedPlan(), warnings: [] },
  });
  emitStatus();
}

let partial = '';
socket.on('data', (chunk) => {
  partial += chunk.toString('utf8');
  const lines = partial.split('\n');
  partial = lines.pop() ?? '';
  for (const line of lines) {
    if (!line.trim()) continue;
    let command;
    try {
      command = JSON.parse(line);
    } catch {
      continue;
    }
    handle(command);
  }
});

function handle(command) {
  switch (command.cmd) {
    case 'setPlan':
      applyPlan(command.plan ?? {});
      break;
    case 'start':
      startSweeping();
      break;
    case 'stop':
      stopSweeping();
      emitStatus();
      break;
    case 'single':
      emitSweep();
      stopSweeping();
      break;
    case 'getStatus':
      emitStatus();
      break;
    case 'shutdown':
      process.exit(0);
      break;
    default:
      break;
  }
}

function applyPlan(patch) {
  if (startingUp) {
    earlyPlans.push(patch);
    return;
  }
  const merged = { ...plan };
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined) merged[k] = v;
  }
  // What the real engine echoes as `requested`: the whole plan it is working
  // from, with the patch laid over it, before any clamping or snapping.
  const requested = { ...merged };
  const warnings = [];
  merged.startHz = Math.min(Math.max(merged.startHz, 70e6), 6e9);
  merged.stopHz = Math.min(Math.max(merged.stopHz, merged.startHz + 1e6), 6e9);
  // the engine's own rule: no narrower than RBW / 1000, no wider than the RBW
  if (!(merged.vbwHz > 0)) merged.vbwHz = merged.rbwHz / 10;
  if (merged.vbwHz > merged.rbwHz) {
    merged.vbwHz = merged.rbwHz;
    warnings.push('vbwHz limited to rbwHz');
  }
  merged.vbwHz = Math.max(merged.vbwHz, merged.rbwHz / 1000);
  if (!(merged.dwell in DWELL_MIN_AVERAGES)) merged.dwell = 'coordination';
  merged.window = merged.window === 'hann' ? 'hann' : 'bh4';
  plan = merged;
  grid = snapToGrid(plan.startHz, plan.stopHz, plan.rbwHz);
  if (Math.abs(grid.startHz - plan.startHz) > 1e-6) {
    warnings.push(`startHz snapped to ${(grid.startHz / 1e6).toFixed(3)} MHz`);
  }
  if (Math.abs(grid.stopHz - plan.stopHz) > 1e-6) {
    warnings.push(`stopHz snapped to ${(grid.stopHz / 1e6).toFixed(3)} MHz`);
  }
  send({
    msgType: MsgType.Status,
    profileId: 7,
    json: { type: 'applied', requested, applied: appliedPlan(), warnings },
  });
  emitStatus();
  if (sweeping) startSweeping();
}

/** Spectra averaged per sub-window: RBW ÷ VBW, or the dwell's minimum if that is more. */
function averagesFor(p) {
  const fromVbw = Math.min(1000, Math.max(1, Math.round(p.rbwHz / p.vbwHz)));
  return Math.max(fromVbw, DWELL_MIN_AVERAGES[p.dwell] ?? DWELL_MIN_AVERAGES.coordination);
}

/**
 * The sweep time the engine would predict: LO positions across the span, each
 * its dead time plus a capture that grows with the averaging. The fake's own
 * sweeps keep arriving every SWEEP_MS regardless.
 */
function predictedSweepMs(p, nAvg) {
  const hops = Math.max(1, Math.ceil((grid.stopHz - grid.startHz) / HOP_HZ));
  const captureMs = (10 * nAvg) / DWELL_MIN_AVERAGES.coordination;
  return Math.max(SWEEP_MS, hops * (HOP_DEAD_MS + captureMs));
}

function appliedPlan() {
  const nAvg = averagesFor(plan);
  return {
    ...plan,
    startHz: grid.startHz,
    stopHz: grid.stopHz,
    stepHz: grid.stepHz,
    binCount: grid.binCount,
    profile: 'usb3-56',
    gainDb: gainFor(plan),
    gainCapDb: 60,
    gainStartDb: 30,
    loGridAutoShiftHz: 0,
    nAvg,
    predictedSweepMs: predictedSweepMs(plan, nAvg),
    predictedSigmaDb: 0.6,
  };
}

function emitStatus() {
  send({
    msgType: MsgType.Status,
    profileId: 7,
    json: {
      type: 'status',
      engineUp: true,
      device: {
        serial: DEVICE.serial,
        product: DEVICE.product,
        usbVersion: 3,
        linkMaxRateBps: 500e6,
        mcrHz: 56e6,
        rateHz: 56e6,
        fpga: 'fake-16.0',
        fw: 'fake-8.0',
        antenna: plan.antenna,
        tempC: 41.5,
        gainRange: [0, 76],
      },
      profile: 'usb3-56',
      profileId: 7,
      plan: appliedPlan(),
      sweeping,
      sweepId,
      sweepsPerSec: sweeping ? 1000 / SWEEP_MS : 0,
      sweepMs: SWEEP_MS,
      gainDb: gainFor(plan),
      kDbm: 10 - gainFor(plan),
      calibrated: false,
      calSource: 'default',
      completedSweeps: sweepId,
      lateStarts: 0,
      // conditions the plugin turns into warnings, switchable for the tests:
      //   SB_USRP_MOCK_OVERLOAD=1    clipping and a hot input
      //   SB_USRP_MOCK_OVERFLOWS=1   the USB link dropping samples
      overflows: process.env.SB_USRP_MOCK_OVERFLOWS === '1' ? ++overflows * 3 : 0,
      clipFraction: process.env.SB_USRP_MOCK_OVERLOAD === '1' ? 0.12 : 0,
      // "hot" means hot at the antenna: −18 dBm input, whatever the gain is
      peakDbfs: process.env.SB_USRP_MOCK_OVERLOAD === '1' ? -18 - (10 - gainFor(plan)) : -30,
      uptimeS: (Date.now() - startedAt) / 1000,
    },
  });
}

function startSweeping() {
  sweeping = true;
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = setInterval(emitSweep, SWEEP_MS);
  sweepTimer.unref?.();
  emitStatus();
}

function stopSweeping() {
  sweeping = false;
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = null;
}

function emitSweep() {
  // SB_USRP_MOCK_STALL_AFTER_MS: the radio stops completing sweeps while its
  // status keeps arriving — the shape of a wedged stream, as opposed to a
  // dead engine, which is what onFatal covers
  const stallAfter = Number(process.env.SB_USRP_MOCK_STALL_AFTER_MS);
  if (stallAfter > 0 && Date.now() - startedAt > stallAfter) return;
  sweepId += 1;
  const { startHz, stepHz, binCount } = grid;
  const gainDb = gainFor(plan);
  const kDbm = 10 - gainDb;
  const avg = new Float32Array(binCount);
  const peak = new Float32Array(binCount);
  const mask = new Uint8Array(binCount);
  const withTransient = sweepId % TRANSIENT.everyNth === 0;
  // The engine reports dBFS; dBm = value + kDbm. Building the scene in dBm and
  // converting keeps the fake honest about which end of that the wire carries.
  for (let i = 0; i < binCount; i += 1) {
    const f = startHz + i * stepHz;
    let powerMw = 10 ** (FLOOR_DBM / 10) * (0.7 + 0.6 * random());
    for (const e of SCENE) powerMw += emitterMw(e, f, stepHz);
    if (withTransient) powerMw += emitterMw(TRANSIENT, f, stepHz);
    const dbm = 10 * Math.log10(powerMw);
    avg[i] = dbm - kDbm;
    peak[i] = dbm - kDbm + 1.5;
    // Masked, a spur's cells are flagged and read like their neighbours;
    // unmasked, the cell on the spur reads the spur.
    for (const spur of SPURS_HZ) {
      if (plan.spurMask !== false) {
        if (Math.abs(f - spur) <= Math.max(stepHz, GRID_MAX_STEP_HZ)) {
          mask[i] = MaskBit.spur | MaskBit.interpolated;
        }
      } else if (Math.abs(f - spur) < stepHz / 2) {
        const withSpur = 10 * Math.log10(10 ** (dbm / 10) + 10 ** (SPUR_DBM / 10));
        avg[i] = withSpur - kDbm;
        peak[i] = withSpur - kDbm + 1.5;
      }
    }
  }
  const detector = plan.detector ?? 'rms';
  const second =
    detector === 'min'
      ? { detector: Detector.min, kind: TraceKind.liveMin }
      : detector === 'sample'
        ? { detector: Detector.sample, kind: TraceKind.liveSample }
        : { detector: Detector.peak, kind: TraceKind.livePeak };
  send({
    msgType: MsgType.TraceComplete,
    flags: Flags.sweepComplete | Flags.uncalibrated,
    sweepId,
    startHz,
    stepHz,
    tDeviceS: (Date.now() - startedAt) / 1000,
    binCount,
    rbwHz: plan.rbwHz,
    gainDb,
    kDbm,
    navg: 31,
    profileId: 7,
    traces: [
      {
        detector: Detector.rms,
        kind: TraceKind.liveAvg,
        avgCount: 31,
        filledBins: binCount,
        values: avg,
      },
      { ...second, avgCount: 31, filledBins: binCount, values: peak },
      {
        detector: Detector.na,
        kind: TraceKind.mask,
        avgCount: 1,
        filledBins: binCount,
        mask,
      },
    ],
  });
}

/** Power in mW that one emitter contributes to the cell at `f`. */
function emitterMw(emitter, f, stepHz) {
  const { hz, levelDbm, halfWidthHz } = emitter;
  const mw = 10 ** (levelDbm / 10);
  if (halfWidthHz > 0) {
    if (Math.abs(f - hz) > halfWidthHz) return 0;
    // spread across the pedestal, per cell
    return (mw * stepHz) / (2 * halfWidthHz);
  }
  const width = Math.max(stepHz, 1);
  const d = (f - hz) / width;
  return mw * Math.exp(-(d ** 2) * 2);
}

// Deterministic noise, so a failing test fails the same way twice.
let seed = 0x2545f491;
function random() {
  seed = (seed + 0x6d2b79f5) >>> 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function send(frame) {
  seq += 1;
  socket.write(lengthPrefixed(encodeFrame({ dtype: 0, flags: 0, seq, ...frame })));
}
