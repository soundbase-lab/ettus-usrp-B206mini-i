// Turning a SoundBase sweep configuration into an engine plan, and an engine
// sweep back into the trace SoundBase draws.
//
// The engine sweeps its own grid: `stepHz = min(25 kHz, RBW)`, `startHz` floored
// onto that grid and `stopHz` ceiled, because that is what its LO plan and FFT
// cells produce. SoundBase reconstructs frequencies as
// `startHz + i·(stopHz − startHz)/(pointCount − 1)`, so the adapter echoes the
// grid the engine settled on and hands every cell back as a point. A requested
// point count or step is not a setting this radio takes: the cells are the
// measurement, and asking for more of them invents resolution the radio did
// not measure while asking for fewer throws away resolution it did. The only
// time the trace is coarser than the grid is when the grid would not fit in
// one trace response, and then cells are collapsed by an integer factor so the
// points still sit on cell centres.
//
// Everything here is pure. The engine's `applied` echo is authoritative for what
// it did; these functions only shape requests and reshape results.

/** B200-series tuning range. The engine clamps too; this shapes SoundBase's UI. */
export const DEVICE_MIN_HZ = 70e6;
export const DEVICE_MAX_HZ = 6e9;

/** Resolution bandwidths the engine realises exactly (within 2 %). */
export const RBW_PRESETS_HZ = [6.25e3, 12.5e3, 25e3, 50e3, 100e3, 200e3];

/** Video bandwidths offered: each RBW preset, and each divided by ten. */
export const VBW_PRESETS_HZ = [
  ...new Set([...RBW_PRESETS_HZ, ...RBW_PRESETS_HZ.map((r) => r / 10)]),
].sort((a, b) => a - b);

/** Output cells are never coarser than 25 kHz, whatever the RBW. */
export const GRID_MAX_STEP_HZ = 25e3;

/** Auto gain is capped at g = −refLevel, and never above this. */
export const GAIN_HARD_CAP_DB = 60;
export const GAIN_MIN_DB = 0;
export const GAIN_MAX_DB = 76;

/**
 * Reference levels that map onto a usable gain.
 *
 * The reference level is the strongest input the trace is expected to carry.
 * In auto gain mode the engine caps the RX gain at `K⁻¹(refLevel + 10 dB)`,
 * which with its built-in `K(g) = 10 − g` model is simply `g = −refLevel`, and
 * never above the hard cap — so a reference level of −50 dBm means at most
 * 50 dB of gain, and the usable reference levels are exactly those that land
 * between 0 dB and the cap. Same method as usrp-scanner; the engine also
 * restarts its auto-gain creep from `gainStartDb` whenever the level changes.
 */
export const MIN_REF_LEVEL_DBM = -GAIN_HARD_CAP_DB;
export const MAX_REF_LEVEL_DBM = 0;
/** 50 dB of gain: the right starting point for a UHF venue scan. */
export const DEFAULT_REF_LEVEL_DBM = -50;

/**
 * The most points one trace carries. A 6 GHz span at 6.25 kHz is 950 000
 * cells; beyond this the trace is decimated by an integer factor instead.
 */
export const MAX_POINTS = 32768;

export const DWELLS = ['fast', 'coordination', 'hq'];
export const DETECTORS = ['rms', 'peak', 'sample', 'min'];
export const ANTENNAS = ['RX2', 'TX/RX'];
export const USB2_PROFILES = ['usb2', 'usb2-simple', 'usb2-turbo'];
export const USB3_PROFILES = ['usb3-16', 'usb3-28', 'usb3-32', 'usb3-56'];

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * The engine's output grid for a span and RBW: start floored, stop ceiled, step
 * `min(25 kHz, RBW)`. Mirrors the engine so the adapter can predict a geometry
 * before the first `applied` arrives; the engine's echo overrides it.
 */
export function snapToGrid(startHz, stopHz, rbwHz) {
  const stepHz = Math.min(GRID_MAX_STEP_HZ, rbwHz);
  const lo = Math.min(startHz, stopHz);
  const hi = Math.max(startHz, stopHz);
  const start = Math.floor(lo / stepHz + 1e-9) * stepHz;
  let stop = Math.ceil(hi / stepHz - 1e-9) * stepHz;
  if (stop <= start) stop = start + stepHz;
  return {
    startHz: start,
    stopHz: stop,
    stepHz,
    binCount: Math.round((stop - start) / stepHz) + 1,
  };
}

/**
 * The trace SoundBase gets for an engine grid: every cell, as a point.
 *
 * `pointCount` is not taken from the request — see the header. When the grid
 * has more cells than one trace may carry, `factor` adjacent cells collapse
 * into each point, and `stopHz` is pulled in to the last point actually
 * reported so that SoundBase's reconstructed axis still lands on cell centres.
 * Whatever `applyConfig` echoes and whatever `traceToPoints` produces come
 * from this one object, which is what keeps the plot at the right frequencies.
 */
export function nativeGeometry(grid, maxPoints = MAX_POINTS) {
  const factor = Math.max(1, Math.ceil(grid.binCount / maxPoints));
  const pointCount = Math.max(2, Math.ceil(grid.binCount / factor));
  const stepHz = grid.stepHz * factor;
  return {
    startHz: grid.startHz,
    stopHz: grid.startHz + (pointCount - 1) * stepHz,
    stepHz,
    pointCount,
    factor,
  };
}

/**
 * Replace cells with no data (NaN, or the mask's hole bit) by the nearest valid
 * neighbour, ties to the lower frequency. A hole is an LO gap or a masked spur,
 * not a measurement of −∞, and a plot draws a cliff through either one.
 * Returns null when the sweep has no valid cell at all.
 */
export function fillGaps(values, mask) {
  const n = values.length;
  const out = new Float64Array(n);
  const valid = new Uint8Array(n);
  let anyValid = false;
  for (let i = 0; i < n; i += 1) {
    const v = values[i];
    const hole = mask !== undefined && ((mask[i] ?? 0) & 1) !== 0;
    out[i] = v;
    if (Number.isFinite(v) && !hole) {
      valid[i] = 1;
      anyValid = true;
    }
  }
  if (n === 0) return out;
  if (!anyValid) return null;
  let last = -1;
  const leftIdx = new Int32Array(n);
  for (let i = 0; i < n; i += 1) {
    if (valid[i]) last = i;
    leftIdx[i] = last;
  }
  last = -1;
  const rightIdx = new Int32Array(n);
  for (let i = n - 1; i >= 0; i -= 1) {
    if (valid[i]) last = i;
    rightIdx[i] = last;
  }
  for (let i = 0; i < n; i += 1) {
    if (valid[i]) continue;
    const l = leftIdx[i];
    const r = rightIdx[i];
    let src;
    if (l < 0) src = r;
    else if (r < 0) src = l;
    else src = i - l <= r - i ? l : r;
    out[i] = out[src];
  }
  return out;
}

/** How several engine cells collapse into one SoundBase point, per detector. */
export function reducerFor(detector) {
  return detector === 'min' ? 'min' : 'max';
}

/**
 * Collapse every `factor` adjacent cells into one point.
 *
 * `max` by default rather than a mean, because a mean averages away a carrier
 * narrower than the point spacing, and a coordination scan exists to find
 * exactly those; `min` when the trace is a negative-peak one, so a
 * minimum-hold request does not report peaks instead. A factor of 1 is the
 * common case and copies the cells through.
 */
export function decimate(values, factor, reducer = 'max') {
  const n = values.length;
  const k = Math.max(1, Math.floor(factor));
  const out = new Array(Math.ceil(n / k));
  for (let j = 0, i = 0; i < n; j += 1, i += k) {
    const end = Math.min(n, i + k);
    let acc = values[i];
    if (reducer === 'min') {
      for (let m = i + 1; m < end; m += 1) if (values[m] < acc) acc = values[m];
    } else {
      for (let m = i + 1; m < end; m += 1) if (values[m] > acc) acc = values[m];
    }
    out[j] = round1(acc);
  }
  return out;
}

const round1 = (v) => Math.round(v * 10) / 10;

/**
 * A complete engine frame in dBm, on the points `nativeGeometry` promised.
 * Returns null when the sweep carried no usable cell, which is a sweep to skip
 * rather than a device error.
 */
export function traceToPoints(frame, trace, mask, geometry, offsetDb = 0) {
  const filled = fillGaps(trace.values, mask);
  if (!filled) return null;
  const add = frame.kDbm + offsetDb;
  for (let i = 0; i < filled.length; i += 1) filled[i] += add;
  const points = decimate(filled, geometry.factor ?? 1, geometry.reducer);
  // A frame is only handed here when it matches the grid, so this is a
  // belt-and-braces check that the promise to SoundBase is kept exactly.
  return points.length === geometry.pointCount ? points : null;
}
