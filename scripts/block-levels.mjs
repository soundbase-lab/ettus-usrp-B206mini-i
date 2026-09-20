#!/usr/bin/env node
// Per-channel level over time from an `engine --record` capture: did the receiver move, or
// did the air?
//
//   node scripts/block-levels.mjs FILE.frames [--block 6] [--skip 2] [--csv out.csv]
//
// The span is cut into blocks of --block MHz from its start (6 MHz from 470 lands on the
// ATSC channels), and each sweep contributes the median of the measured cells in each
// block. Everything below is a statistic of those per-sweep block levels, and the report
// answers one question: when a level moves between sweeps, is it the receiver or the
// signal? The two leave different fingerprints.
//
//   receiver: a block flickers, changing by whole dB between consecutive sweeps 50 ms
//             apart (the LO hump does this to the empty blocks near an LO); p10 moves (the
//             floor is the radio's own noise); a common mode runs through every occupied
//             block at once (gain, LO, settle and stitch all move a whole capture window
//             together); or even and odd sweeps disagree (the two LO grids read different
//             levels)
//   air:      occupied blocks move independently of each other and of the floor, slowly
//             (lag-1 correlation near 1, small sweep-to-sweep jumps); cells inside a block
//             move relative to one another; and the weakest blocks move most. That is
//             multipath fading, and a stationary antenna does not prevent it. A weak
//             station that fades up out of the floor is a signal block with a step in it,
//             not a flicker.
//
// Exit 1 when a receiver signature is present, so it can sit beside find-phantoms in a
// check. The thresholds are the named constants below. Sweeps whose gain differs from the
// capture's modal gain are skipped, as are the first --skip seconds. The even/odd split is
// the LO grid only with --interleave; with imageReject each output already averages both
// grids, and in plain mode it is just a sanity split.

import { createReadStream, writeFileSync } from 'node:fs';
import { FrameReassembler, MaskBit, MsgType, decodeFrame, liveTrace, maskOf } from '../driver/frames.js';

const FLOOR_STD_MAX_DB = 0.5;        // p10: the radio's own noise, expected steady
const FLICKER_MAX_DB = 1.0;          // std of the sweep-to-sweep change; the air cannot move this fast
const COMMON_MODE_STD_MAX_DB = 0.75; // every occupied block moving together
const PARITY_MAX_DB = 1.0;           // |even - odd| on any block
const OCCUPIED_ABOVE_FLOOR_DB = 6;   // a block this far above p10 is carrying a signal

const argv = process.argv.slice(2);
const VALUED = new Set(['--block', '--skip', '--csv']);
const file = argv.find((a, i) => !a.startsWith('--') && !VALUED.has(argv[i - 1]));
const num = (name, fallback) => {
  const i = argv.indexOf(name);
  return i === -1 ? fallback : Number(argv[i + 1]);
};
const str = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
};
if (!file) {
  process.stderr.write('usage: block-levels.mjs FILE.frames [--block MHz] [--skip s] [--csv out.csv]\n');
  process.exit(2);
}
const BLOCK_HZ = num('--block', 6) * 1e6;
const SKIP_S = num('--skip', 2);
const CSV = str('--csv');

// ---------------------------------------------------------------------------
// Read the capture

const sweeps = [];
const statuses = [];
let applied = null;
const reassembler = new FrameReassembler((raw) => {
  const f = decodeFrame(raw);
  if (f.msgType === MsgType.Status) {
    if (f.json?.type === 'status') statuses.push(f.json);
    if (f.json?.type === 'applied') applied = f.json.applied;
    return;
  }
  if (f.msgType !== MsgType.TraceComplete) return;
  const values = liveTrace(f)?.values;
  if (!values) return;
  sweeps.push({
    id: f.sweepId, t: f.tDeviceS, gainDb: f.gainDb, kDbm: f.kDbm,
    startHz: f.startHz, stepHz: f.stepHz, values, mask: maskOf(f),
  });
});
for await (const chunk of createReadStream(file)) reassembler.push(chunk);

if (sweeps.length < 10) {
  process.stderr.write(`only ${sweeps.length} sweeps in ${file}; need more to say anything\n`);
  process.exit(2);
}
const t0 = sweeps[0].t;
const gainCounts = new Map();
for (const s of sweeps) gainCounts.set(s.gainDb, (gainCounts.get(s.gainDb) ?? 0) + 1);
const modalGain = [...gainCounts.entries()].sort((a, b) => b[1] - a[1])[0][0];
const use = sweeps.filter((s) => s.gainDb === modalGain && s.t - t0 >= SKIP_S);
if (use.length < 10) {
  process.stderr.write(`only ${use.length} sweeps at the modal gain ${modalGain} dB after --skip ${SKIP_S}s\n`);
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Per-sweep block levels

const { startHz, stepHz } = use[0];
const n = use[0].values.length;
// Hole fill, spur fill and the LO hole are inventions, not measurements.
const NOT_MEASURED = MaskBit.hole | MaskBit.interpolated | MaskBit.spur | MaskBit.overflowInvalid | MaskBit.loHole;

const stopHz = startHz + (n - 1) * stepHz;
const blocks = [];
for (let lo = startHz; lo < stopHz; lo += BLOCK_HZ) {
  const hi = Math.min(lo + BLOCK_HZ, stopHz);
  // Keep clear of the block edges, where a channel's shoulder or its neighbour's leaks in.
  const margin = Math.min(0.5e6, (hi - lo) / 12);
  const a = Math.max(0, Math.ceil((lo + margin - startHz) / stepHz));
  const z = Math.min(n - 1, Math.floor((hi - margin - startHz) / stepHz));
  if (z > a) blocks.push({ lo, hi, a, z, name: (lo / 1e6).toFixed(lo % 1e6 ? 1 : 0) });
}

const sorted = (arr) => Float64Array.from(arr).sort();
const pct = (arr, p) => (arr.length ? sorted(arr)[Math.min(arr.length - 1, Math.floor(p * arr.length))] : NaN);
const med = (arr) => pct(arr, 0.5);
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const std = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((v) => (v - m) ** 2))); };
const corr = (a, b) => {
  const ma = mean(a), mb = mean(b);
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < a.length; i += 1) { sab += (a[i] - ma) * (b[i] - mb); saa += (a[i] - ma) ** 2; sbb += (b[i] - mb) ** 2; }
  return saa && sbb ? sab / Math.sqrt(saa * sbb) : 0;
};
const fixed = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : 'nan');

const rows = [];
const cellMedian = new Float64Array(n); // per cell, across the capture: where the strongest thing is
const column = new Float64Array(use.length);
for (const s of use) {
  const row = { id: s.id, t: s.t - t0, parity: s.id & 1, block: [] };
  const all = [];
  for (let c = 0; c < n; c += 1) {
    const v = s.values[c];
    if (Number.isFinite(v) && !(s.mask[c] & NOT_MEASURED)) all.push(v + s.kDbm);
  }
  row.p10 = pct(all, 0.1);
  row.median = pct(all, 0.5);
  for (const b of blocks) {
    const vals = [];
    for (let c = b.a; c <= b.z; c += 1) {
      const v = s.values[c];
      if (Number.isFinite(v) && !(s.mask[c] & NOT_MEASURED)) vals.push(v + s.kDbm);
    }
    row.block.push(med(vals));
  }
  rows.push(row);
}
for (let c = 0; c < n; c += 1) {
  let m = 0;
  for (const s of use) { const v = s.values[c]; if (Number.isFinite(v)) column[m++] = v + s.kDbm; }
  cellMedian[c] = m ? sorted(column.subarray(0, m))[m >> 1] : NaN;
}

// ---------------------------------------------------------------------------
// Report

const durS = rows[rows.length - 1].t - rows[0].t;
const series = (fn) => rows.map(fn);
const p10s = series((r) => r.p10), medians = series((r) => r.median);
const floorRef = med(p10s);
const last = statuses[statuses.length - 1];
const temps = statuses.map((s) => s.device?.tempC).filter((v) => v > 0);

process.stdout.write(
  `${file}\n${rows.length} sweeps over ${durS.toFixed(1)} s (${(rows.length / durS).toFixed(1)}/s) at ${modalGain} dB` +
    (applied ? `; imageReject=${applied.imageReject} interleave=${applied.interleave} rbw=${applied.rbwHz / 1e3} kHz nAvg=${applied.nAvg}` : '') +
    (temps.length ? `; temp ${Math.min(...temps).toFixed(1)}..${Math.max(...temps).toFixed(1)} C` : '') +
    (last ? `; overflows=${last.overflows} zeroRuns=${last.zeroRuns} lateStarts=${last.lateStarts ?? 'n/a'} captureTimeouts=${last.captureTimeouts}` : '') +
    '\n'
);

let strongest = 0;
for (let c = 1; c < n; c += 1) if (cellMedian[c] > cellMedian[strongest]) strongest = c;
const strongestSeries = use.map((s) => s.values[strongest] + s.kDbm).filter(Number.isFinite);
process.stdout.write(
  `\nwhole trace:   p10 ${fixed(mean(p10s), 1)} dBm std ${fixed(std(p10s))} dB   median ${fixed(mean(medians), 1)} dBm std ${fixed(std(medians))} range ${fixed(pct(medians, 0.98) - pct(medians, 0.02), 1)} dB` +
    `   strongest cell ${((startHz + strongest * stepHz) / 1e6).toFixed(3)} MHz ${fixed(mean(strongestSeries), 1)} dBm std ${fixed(std(strongestSeries))} dB\n`
);

process.stdout.write('\nblock    level    std  p2-p98  jump  even-odd  r(prev)  cellResid  note\n');
const blockSeries = blocks.map((_, b) => series((r) => r.block[b]));
const occupied = [];
const flickering = [];
const parityOff = [];
for (let b = 0; b < blocks.length; b += 1) {
  const x = blockSeries[b];
  if (x.some((v) => !Number.isFinite(v))) { process.stdout.write(`${blocks[b].name.padStart(5)}  (unmeasured cells)\n`); continue; }
  const ev = rows.filter((r) => r.parity === 0).map((r) => r.block[b]);
  const od = rows.filter((r) => r.parity === 1).map((r) => r.block[b]);
  const jumps = x.slice(1).map((v, i) => v - x[i]);
  const parity = ev.length && od.length ? mean(ev) - mean(od) : NaN;
  const occ = mean(x) > floorRef + OCCUPIED_ABOVE_FLOOR_DB;
  if (occ) occupied.push(b);
  // Do the cells of the block move together or against each other? Every 4th cell keeps it quick.
  const resid = [];
  for (let c = blocks[b].a; c <= blocks[b].z; c += 4) {
    const col = use.map((s) => s.values[c] + s.kDbm);
    if (col.every(Number.isFinite)) resid.push(std(col.map((v, i) => v - x[i])));
  }
  const flicker = std(jumps) > FLICKER_MAX_DB;
  if (flicker) flickering.push(blocks[b].name);
  if (Math.abs(parity) > PARITY_MAX_DB) parityOff.push(blocks[b].name);
  process.stdout.write(
    `${blocks[b].name.padStart(5)}  ${fixed(mean(x), 1).padStart(7)}  ${fixed(std(x)).padStart(5)}  ${fixed(pct(x, 0.98) - pct(x, 0.02), 1).padStart(6)}  ${fixed(std(jumps)).padStart(4)}  ${fixed(parity).padStart(8)}  ${fixed(corr(x.slice(1), x.slice(0, -1))).padStart(7)}  ${fixed(resid.length ? mean(resid) : NaN).padStart(9)}  ${occ ? 'signal' : 'empty'}${flicker ? ' FLICKER' : ''}\n`
  );
}
process.stdout.write(
  '  level: mean of the per-sweep block median, dBm. std/p2-p98: how much it moved. jump: std of the sweep-to-sweep change.\n' +
    '  even-odd: mean difference between the two sweep parities. r(prev): lag-1 autocorrelation (near 1 = slow drift, near 0 = flicker).\n' +
    '  cellResid: std of (cell - block median), i.e. movement inside the block that the block as a whole did not make.\n'
);

let commonStd = NaN;
if (occupied.length >= 2) {
  const cm = rows.map((r) => mean(occupied.map((b) => r.block[b])));
  commonStd = std(cm);
  const byDist = new Map();
  for (let i = 0; i < occupied.length; i += 1) {
    for (let j = i + 1; j < occupied.length; j += 1) {
      const d = occupied[j] - occupied[i];
      if (!byDist.has(d)) byDist.set(d, []);
      byDist.get(d).push(corr(blockSeries[occupied[i]], blockSeries[occupied[j]]));
    }
  }
  process.stdout.write(
    `\n${occupied.length} signal blocks: common mode std ${fixed(commonStd)} dB, p2-p98 ${fixed(pct(cm, 0.98) - pct(cm, 0.02), 1)} dB; ` +
      `mean residual after removing it ${fixed(mean(occupied.map((b) => std(blockSeries[b].map((v, i) => v - cm[i])))))} dB\n` +
      `correlation between signal blocks by separation (blocks): ` +
      [...byDist.entries()].sort((a, b) => a[0] - b[0]).slice(0, 12).map(([d, cs]) => `${d}:${fixed(mean(cs))}`).join('  ') + '\n'
  );
  // Where the movement lives in time: a coarse DFT of the common mode.
  const N = 1 << Math.floor(Math.log2(cm.length));
  const m = mean(cm), v = cm.map((x) => x - m);
  const dt = durS / (rows.length - 1);
  const spec = [];
  for (let k = 1; k < N / 2; k += 1) {
    let re = 0, im = 0;
    for (let i = 0; i < N; i += 1) { const ph = (2 * Math.PI * k * i) / N; re += v[i] * Math.cos(ph); im -= v[i] * Math.sin(ph); }
    spec.push({ periodS: (N * dt) / k, p: re * re + im * im });
  }
  const total = spec.reduce((a, s) => a + s.p, 0) || 1;
  const bands = [[0, 0.5], [0.5, 2], [2, 8], [8, Infinity]];
  process.stdout.write(
    'common-mode energy by period: ' +
      bands.map(([a, b]) => `${a}-${b === Infinity ? 'inf' : b}s ${((100 * spec.filter((s) => s.periodS >= a && s.periodS < b).reduce((x, s) => x + s.p, 0)) / total).toFixed(0)}%`).join('  ') + '\n'
  );
}

const floorStd = std(p10s);
const reasons = [];
if (floorStd > FLOOR_STD_MAX_DB) reasons.push(`p10 floor std ${fixed(floorStd)} dB > ${FLOOR_STD_MAX_DB}`);
if (flickering.length) reasons.push(`block(s) flickering sweep to sweep > ${FLICKER_MAX_DB} dB: ${flickering.join(', ')} MHz`);
if (Number.isFinite(commonStd) && commonStd > COMMON_MODE_STD_MAX_DB) reasons.push(`common mode std ${fixed(commonStd)} dB > ${COMMON_MODE_STD_MAX_DB}`);
if (parityOff.length) reasons.push(`even/odd differ > ${PARITY_MAX_DB} dB: ${parityOff.join(', ')} MHz`);
process.stdout.write(
  reasons.length
    ? `\nreceiver: SUSPECT - ${reasons.join('; ')}\n`
    : `\nreceiver: steady (p10 std ${fixed(floorStd)} dB, no block flickers > ${FLICKER_MAX_DB} dB sweep to sweep, common mode ${fixed(commonStd)} dB, even/odd within ${PARITY_MAX_DB} dB). ` +
      'Whatever moved, moved per block: that is the air.\n'
);

if (CSV) {
  const head = ['sweepId', 't', 'parity', 'p10', 'median', ...blocks.map((b) => `b${b.name}`)];
  const lines = rows.map((r) => [r.id, r.t.toFixed(3), r.parity, fixed(r.p10), fixed(r.median), ...r.block.map((v) => fixed(v))].join(','));
  writeFileSync(CSV, `${head.join(',')}\n${lines.join('\n')}\n`);
  process.stderr.write(`wrote ${CSV}\n`);
}
process.exit(reasons.length ? 1 : 0);
