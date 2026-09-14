// The geometry the engine sweeps on, and the trace SoundBase draws.
//
// The engine's cells fall on multiples of min(25 kHz, RBW) because that is what
// its LO plan produces, and SoundBase draws point i at
// startHz + i·(stopHz − startHz)/(pointCount − 1). The plugin hands the cells
// over as the points, so those two only agree if the echoed startHz, stopHz and
// pointCount describe the cells exactly. Everything that can go wrong — a trace
// that looks right but sits one cell off in frequency, a carrier lost when a
// huge grid is decimated, a masked spur drawn as a cliff — goes wrong here.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_POINTS,
  decimate,
  fillGaps,
  nativeGeometry,
  reducerFor,
  snapToGrid,
  traceToPoints,
} from '../driver/plan.js';

test('a span snaps outwards onto the acquisition grid', () => {
  const grid = snapToGrid(470.01e6, 607.99e6, 25e3);
  assert.equal(grid.stepHz, 25e3);
  assert.equal(grid.startHz, 470.0e6);
  assert.equal(grid.stopHz, 608.0e6);
  assert.equal(grid.binCount, 5521);
  // the grid never gets coarser than 25 kHz, whatever the RBW
  assert.equal(snapToGrid(470e6, 608e6, 200e3).stepHz, 25e3);
  assert.equal(snapToGrid(470e6, 608e6, 6.25e3).stepHz, 6.25e3);
});

test('the trace is the grid: one point per cell, whatever was asked for', () => {
  const grid = snapToGrid(470e6, 608e6, 25e3);
  const geometry = nativeGeometry(grid);
  assert.equal(geometry.pointCount, grid.binCount);
  assert.equal(geometry.startHz, grid.startHz);
  assert.equal(geometry.stopHz, grid.stopHz);
  assert.equal(geometry.stepHz, grid.stepHz);
  assert.equal(geometry.factor, 1);
  // SoundBase reconstructs the axis from start, stop and count, and that has
  // to land every point on a cell centre
  const reconstructed =
    (geometry.stopHz - geometry.startHz) / (geometry.pointCount - 1);
  assert.equal(reconstructed, grid.stepHz);
});

test('a grid too large for one trace is decimated, and the echo says so', () => {
  // 6.25 kHz cells across the whole tuning range: ~950 000 of them
  const grid = snapToGrid(70e6, 6e9, 6.25e3);
  assert.ok(grid.binCount > MAX_POINTS);
  const geometry = nativeGeometry(grid);
  assert.ok(geometry.pointCount <= MAX_POINTS);
  assert.ok(geometry.factor > 1);
  // points stay on cell centres: the step is a whole number of cells, and the
  // echoed stop is the last point actually reported
  assert.equal(geometry.stepHz, grid.stepHz * geometry.factor);
  assert.equal(
    geometry.stopHz,
    geometry.startHz + (geometry.pointCount - 1) * geometry.stepHz
  );
  assert.ok(geometry.stopHz <= grid.stopHz);
  assert.equal(
    geometry.pointCount,
    decimate(new Float64Array(grid.binCount), geometry.factor).length
  );
});

test('holes and masked cells are filled from their neighbours', () => {
  // NaN is "the sweep has no data here" — an LO gap, a dropped sub-window.
  assert.deepEqual([...fillGaps([Number.NaN, -90, -80, Number.NaN])], [-90, -90, -80, -80]);
  // the mask's hole bit says the same thing about a cell that carries a number
  assert.deepEqual([...fillGaps([-140, -90, -80], Uint8Array.from([1, 0, 0]))], [-90, -90, -80]);
  // a sweep with nothing valid in it is not a trace, and says so
  assert.equal(fillGaps([Number.NaN, Number.NaN]), null);
});

test('decimation keeps the peak, because a narrow carrier is the point', () => {
  // 25 kHz cells across 1 MHz, with a carrier 40 dB up in exactly one of them
  const values = new Float64Array(41).fill(-105);
  values[20] = -60;

  const points = decimate(values, 10);
  assert.equal(points.length, 5);
  assert.equal(points[2], -60, 'the carrier survives a 250 kHz point spacing');
  assert.deepEqual(points.slice(0, 2), [-105, -105]);

  // a negative-peak trace must not report the peak instead
  assert.equal(decimate(values, 10, 'min')[2], -105);
  assert.equal(reducerFor('min'), 'min');
  assert.equal(reducerFor('rms'), 'max');

  // a factor of one is a copy, to a tenth of a dB
  assert.deepEqual(decimate(Float64Array.from([-100.04, -50.06]), 1), [-100, -50.1]);
});

test('points land on the frequencies SoundBase reconstructs', () => {
  // a feature at a known frequency has to come back at the matching index,
  // both on the native grid and after decimation
  const grid = snapToGrid(470e6, 608e6, 25e3);
  const values = new Float32Array(grid.binCount).fill(-105);
  const carrierHz = 542.1e6;
  const cell = Math.round((carrierHz - 470e6) / 25e3);
  values[cell] = -50;
  const frame = { startHz: grid.startHz, stepHz: grid.stepHz, kDbm: 0 };

  const native = nativeGeometry(grid);
  const points = traceToPoints(frame, { values }, undefined, { ...native, reducer: 'max' });
  assert.equal(points.length, native.pointCount);
  assert.equal(points.indexOf(Math.max(...points)), cell);

  const coarse = nativeGeometry(grid, 1000);
  const fewer = traceToPoints(frame, { values }, undefined, { ...coarse, reducer: 'max' });
  assert.equal(fewer.length, coarse.pointCount);
  const peakIndex = fewer.indexOf(Math.max(...fewer));
  const expected = Math.round(
    ((carrierHz - coarse.startHz) / (coarse.stopHz - coarse.startHz)) * (coarse.pointCount - 1)
  );
  assert.ok(Math.abs(peakIndex - expected) <= 1, `carrier drawn at ${peakIndex}, expected ${expected}`);
});

test('the level offset and kDbm reach every point, and a dead sweep is null', () => {
  const grid = snapToGrid(500e6, 500.1e6, 25e3);
  const geometry = { ...nativeGeometry(grid), reducer: 'max' };
  const frame = { startHz: grid.startHz, stepHz: grid.stepHz, kDbm: -40 };
  const values = new Float32Array(grid.binCount).fill(-60);
  assert.deepEqual(traceToPoints(frame, { values }, undefined, geometry, 2.5), [
    -97.5, -97.5, -97.5, -97.5, -97.5,
  ]);
  assert.equal(
    traceToPoints(frame, { values: new Float32Array(grid.binCount).fill(NaN) }, undefined, geometry),
    null
  );
});
