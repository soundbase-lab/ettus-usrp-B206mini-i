// The geometry the engine sweeps on, and the points SoundBase draws.
//
// These two grids are not the same and never will be: the engine's cells fall
// on multiples of min(25 kHz, RBW) because that is what its LO plan produces,
// and SoundBase wants exactly `pointCount` amplitudes evenly spaced from
// startHz to stopHz. Everything that can go wrong in between — a trace that
// looks right but sits one cell off in frequency, a carrier averaged away by a
// coarser request, a masked spur drawn as a cliff — goes wrong here.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  fillGaps,
  reducerFor,
  resampleTrace,
  resolvePointCount,
  snapToGrid,
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

test('pointCount wins over stepHz, and neither means the native cells', () => {
  const grid = snapToGrid(470e6, 608e6, 25e3);
  assert.equal(resolvePointCount({ pointCount: 401, stepHz: 1e6 }, grid), 401);
  assert.equal(resolvePointCount({ stepHz: 1e6 }, grid), 139);
  assert.equal(resolvePointCount({}, grid), grid.binCount);
  // a previous count survives a patch that says nothing about geometry
  assert.equal(resolvePointCount({}, grid, 401), 401);
  // and an absurd request is clamped rather than refused
  assert.ok(resolvePointCount({ pointCount: 1e9 }, grid) < 1e9);
  assert.equal(resolvePointCount({ pointCount: 0 }, grid), 2);
});

test('holes and masked cells are filled from their neighbours', () => {
  // NaN is "the sweep has no data here" — an LO gap, a dropped sub-window.
  assert.deepEqual([...fillGaps([Number.NaN, -90, -80, Number.NaN])], [-90, -90, -80, -80]);
  // the mask's hole bit says the same thing about a cell that carries a number
  assert.deepEqual([...fillGaps([-140, -90, -80], Uint8Array.from([1, 0, 0]))], [-90, -90, -80]);
  // a sweep with nothing valid in it is not a trace, and says so
  assert.equal(fillGaps([Number.NaN, Number.NaN]), null);
});

test('coarsening keeps the peak, because a narrow carrier is the point', () => {
  // 25 kHz cells across 1 MHz, with a carrier 40 dB up in exactly one of them
  const values = new Float64Array(41).fill(-105);
  values[20] = -60;
  const source = { startHz: 500e6, stepHz: 25e3, values };

  const points = resampleTrace(source, {
    startHz: 500e6,
    stopHz: 501e6,
    pointCount: 5,
  });
  assert.equal(points.length, 5);
  assert.equal(points[2], -60, 'the carrier survives a 250 kHz point spacing');
  assert.deepEqual(points.slice(0, 2), [-105, -105]);

  // a mean would lose it, which is why max is the default and mean is opt-in
  const averaged = resampleTrace(source, {
    startHz: 500e6,
    stopHz: 501e6,
    pointCount: 5,
    reducer: 'mean',
  });
  assert.ok(averaged[2] < -65, `mean kept ${averaged[2]}`);

  // and a minimum-hold request must not report the peak instead
  const minimum = resampleTrace(source, {
    startHz: 500e6,
    stopHz: 501e6,
    pointCount: 5,
    reducer: 'min',
  });
  assert.equal(minimum[2], -105);
  assert.equal(reducerFor('min'), 'min');
  assert.equal(reducerFor('rms'), 'max');
});

test('points land on the frequencies SoundBase reconstructs', () => {
  // SoundBase draws point i at startHz + i·(stopHz − startHz)/(pointCount − 1),
  // so a feature at a known frequency has to come back at the matching index.
  const values = new Float64Array(5521).fill(-105);
  const carrierHz = 542.1e6;
  values[Math.round((carrierHz - 470e6) / 25e3)] = -50;
  const source = { startHz: 470e6, stepHz: 25e3, values };

  const pointCount = 401;
  const points = resampleTrace(source, {
    startHz: 470e6,
    stopHz: 608e6,
    pointCount,
  });
  assert.equal(points.length, pointCount);
  const peakIndex = points.indexOf(Math.max(...points));
  const expected = Math.round(((carrierHz - 470e6) / 138e6) * (pointCount - 1));
  assert.equal(peakIndex, expected);
});

test('asking for more points than there are cells repeats them, never invents', () => {
  const values = Float64Array.from([-100, -50, -100]);
  const points = resampleTrace(
    { startHz: 500e6, stepHz: 25e3, values },
    { startHz: 500e6, stopHz: 500.05e6, pointCount: 11 }
  );
  assert.equal(points.length, 11);
  // every value came from a cell that was measured
  for (const p of points) assert.ok([-100, -50].includes(p), `invented ${p}`);
  assert.equal(points[5], -50);
});
