// Turning a SoundBase sweep configuration into an engine plan, and an engine
// sweep back into the points SoundBase asked for.
//
// The two sides disagree about geometry in one important way. The engine sweeps
// its own grid: `stepHz = min(25 kHz, RBW)`, `startHz` floored onto that grid and
// `stopHz` ceiled, because that is what its LO plan and FFT cells produce.
// SoundBase wants exactly `pointCount` amplitudes and reconstructs frequencies as
// `startHz + i·(stopHz − startHz)/(pointCount − 1)`. So the adapter echoes the
// grid the engine settled on and resamples each sweep onto the requested number
// of points — which is why `resampleTrace` and the `applyConfig` echo have to be
// derived from the same numbers.
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

/** Reference levels that map onto a usable gain: g = 10 − (ref + 10). */
export const MIN_REF_LEVEL_DBM = -GAIN_HARD_CAP_DB;
export const MAX_REF_LEVEL_DBM = 0;

/** Guard against a wide span at a fine step producing an enormous trace. */
export const MAX_POINTS = 32768;
export const MIN_POINTS = 2;

export const DWELLS = ['fast', 'coordination', 'hq'];
export const DETECTORS = ['rms', 'peak', 'sample', 'min'];
export const ANTENNAS = ['RX2', 'TX/RX'];
export const USB2_PROFILES = ['usb2', 'usb2-simple', 'usb2-turbo'];
export const USB3_PROFILES = ['usb3-16', 'usb3-28', 'usb3-32', 'usb3-56'];

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** The nearest value in `choices`, for snapping a request onto what exists. */
export function nearest(value, choices) {
  return choices.reduce((best, candidate) =>
    Math.abs(candidate - value) < Math.abs(best - value) ? candidate : best
  );
}

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
 * How many points to return for a configuration patch.
 *
 * `pointCount` wins over `stepHz` (the shell has already applied that rule, but
 * a device added by hand can carry either), and with neither we hand back the
 * engine's own cells — the finest honest answer, capped so a 6 GHz span at
 * 25 kHz does not produce a 240 000-point array.
 */
export function resolvePointCount(cfg, grid, previous) {
  let n;
  if (isNum(cfg.pointCount)) n = Math.round(cfg.pointCount);
  else if (isNum(cfg.stepHz) && cfg.stepHz > 0) {
    n = Math.round((grid.stopHz - grid.startHz) / cfg.stepHz) + 1;
  } else if (isNum(previous)) n = previous;
  else n = grid.binCount;
  return clamp(n, MIN_POINTS, MAX_POINTS);
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
 * Resample a filled series onto `pointCount` points spanning `[startHz, stopHz]`.
 *
 * When SoundBase asks for fewer points than the engine has cells, each point is
 * the reduction of the cells whose centres fall in its bucket — `max` by default
 * rather than a mean, because a mean averages away a carrier narrower than the
 * point spacing, and a coordination scan exists to find exactly those. When it
 * asks for more, points repeat the nearest cell; the plugin never invents
 * resolution the radio did not measure.
 */
export function resampleTrace(
  source,
  { startHz, stopHz, pointCount, reducer = 'max' }
) {
  const { startHz: srcStart, stepHz: srcStep, values } = source;
  const n = values.length;
  const out = new Array(pointCount);
  const outStep = pointCount > 1 ? (stopHz - startHz) / (pointCount - 1) : 0;
  const half = (outStep > 0 ? outStep : srcStep) / 2;
  for (let j = 0; j < pointCount; j += 1) {
    const fc = startHz + j * outStep;
    let i0 = Math.ceil((fc - half - srcStart) / srcStep - 1e-9);
    let i1 = Math.floor((fc + half - srcStart) / srcStep + 1e-9);
    i0 = Math.max(0, i0);
    i1 = Math.min(n - 1, i1);
    if (i1 < i0) {
      const near = clamp(Math.round((fc - srcStart) / srcStep), 0, n - 1);
      out[j] = round1(values[near]);
      continue;
    }
    let acc = values[i0];
    if (reducer === 'mean') {
      let sum = 0;
      for (let i = i0; i <= i1; i += 1) sum += 10 ** (values[i] / 10);
      acc = 10 * Math.log10(sum / (i1 - i0 + 1));
    } else if (reducer === 'min') {
      for (let i = i0 + 1; i <= i1; i += 1) if (values[i] < acc) acc = values[i];
    } else {
      for (let i = i0 + 1; i <= i1; i += 1) if (values[i] > acc) acc = values[i];
    }
    out[j] = round1(acc);
  }
  return out;
}

const round1 = (v) => Math.round(v * 10) / 10;

/**
 * A complete engine frame in dBm, resampled onto the requested points.
 * Returns null when the sweep carried no usable cell, which is a sweep to skip
 * rather than a device error.
 */
export function traceToPoints(frame, trace, mask, geometry, offsetDb = 0) {
  const filled = fillGaps(trace.values, mask);
  if (!filled) return null;
  const add = frame.kDbm + offsetDb;
  for (let i = 0; i < filled.length; i += 1) filled[i] += add;
  return resampleTrace(
    { startHz: frame.startHz, stepHz: frame.stepHz, values: filled },
    geometry
  );
}
