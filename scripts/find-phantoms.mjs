#!/usr/bin/env node
// Finds sweeps carrying energy that is not on the air.
//
//   node scripts/find-phantoms.mjs FILE.frames [--excess 6] [--width 40] [--skip 2]
//
// Exit 1 if any sweep has one. The test is deliberately the user's symptom and
// nothing else: a run of contiguous cells sitting well above what the same
// cells read on every other sweep in the capture. A real transmitter is in most
// sweeps and so sits at the median; a phantom is in a few and towers over it.
//
// Sweeps whose gain differs from the capture's modal gain are skipped, because
// a gain change moves the floor for honest reasons and this must only go red
// on the dishonest ones.

import { createReadStream } from 'node:fs';
import { FrameReassembler, Flags, MsgType, decodeFrame, liveTrace } from '../driver/frames.js';

const argv = process.argv.slice(2);
const file = argv.find((a) => !a.startsWith('--'));
const num = (name, fallback) => {
  const i = argv.indexOf(name);
  return i === -1 ? fallback : Number(argv[i + 1]);
};
if (!file) {
  process.stderr.write('usage: find-phantoms.mjs FILE.frames [--excess dB] [--width cells] [--skip s]\n');
  process.exit(2);
}
const EXCESS_DB = num('--excess', 6);
const MIN_WIDTH = num('--width', 40);
const SKIP_S = num('--skip', 2);

const FLAG_LETTERS = [
  ['gainChanged', 'G'], ['clipped', 'C'], ['recalHappened', 'R'],
  ['overflowSeen', 'O'], ['interleaveParity', 'i'], ['uncalibrated', 'u'],
];

const sweeps = [];
let statuses = [];

const reassembler = new FrameReassembler((raw) => {
  const f = decodeFrame(raw);
  if (f.msgType === MsgType.Status && f.json?.type === 'status') statuses.push(f.json);
  if (f.msgType !== MsgType.TraceComplete) return;
  const values = liveTrace(f)?.values;
  if (!values) return;
  const dbm = new Float32Array(values.length);
  for (let i = 0; i < values.length; i += 1) dbm[i] = values[i] + f.kDbm;
  sweeps.push({
    sweepId: f.sweepId, t: f.tDeviceS, gainDb: f.gainDb, startHz: f.startHz, stepHz: f.stepHz,
    flags: FLAG_LETTERS.filter(([n]) => f.flags & Flags[n]).map(([, l]) => l).join('') || '-',
    dbm,
  });
});
for await (const chunk of createReadStream(file)) reassembler.push(chunk);

if (sweeps.length < 10) {
  process.stderr.write(`only ${sweeps.length} sweeps in ${file}; need more to build a reference\n`);
  process.exit(2);
}

const t0 = sweeps[0].t;
const gainCounts = new Map();
for (const s of sweeps) gainCounts.set(s.gainDb, (gainCounts.get(s.gainDb) ?? 0) + 1);
const modalGain = [...gainCounts.entries()].sort((a, b) => b[1] - a[1])[0][0];
const usable = sweeps.filter((s) => s.gainDb === modalGain && s.t - t0 >= SKIP_S);
if (usable.length < 10) {
  process.stderr.write(`only ${usable.length} sweeps at the modal gain ${modalGain} dB after --skip ${SKIP_S}s\n`);
  process.exit(2);
}

// Per-cell median across the capture: what is actually on the air.
const n = usable[0].dbm.length;
const reference = new Float32Array(n);
const column = new Float64Array(usable.length);
for (let c = 0; c < n; c += 1) {
  let m = 0;
  for (const s of usable) { const v = s.dbm[c]; if (Number.isFinite(v)) column[m++] = v; }
  if (m === 0) { reference[c] = NaN; continue; }
  const slice = column.slice(0, m).sort();
  reference[c] = slice[Math.floor(m / 2)];
}

const hits = [];
for (const s of usable) {
  let run = 0, best = 0, bestEnd = -1, peak = 0, bestPeak = 0;
  for (let c = 0; c < n; c += 1) {
    const excess = s.dbm[c] - reference[c];
    if (Number.isFinite(excess) && excess > EXCESS_DB) {
      run += 1; peak = Math.max(peak, excess);
      if (run > best) { best = run; bestEnd = c; bestPeak = peak; }
    } else { run = 0; peak = 0; }
  }
  if (best >= MIN_WIDTH) {
    const from = bestEnd - best + 1;
    hits.push({
      sweepId: s.sweepId, t: s.t - t0, gainDb: s.gainDb, flags: s.flags, cells: best,
      fromMHz: (s.startHz + from * s.stepHz) / 1e6,
      toMHz: (s.startHz + bestEnd * s.stepHz) / 1e6,
      peakDb: bestPeak,
    });
  }
}

process.stdout.write(
  `${usable.length} sweeps at ${modalGain} dB examined; ` +
    `phantom = >${EXCESS_DB} dB over the per-cell median for >=${MIN_WIDTH} cells\n`
);
for (const h of hits) {
  process.stdout.write(
    `  sweep ${String(h.sweepId).padStart(5)}  t=${h.t.toFixed(2)}s  flags ${h.flags.padEnd(4)}  ` +
      `${h.fromMHz.toFixed(2)}-${h.toMHz.toFixed(2)} MHz  ${h.cells} cells  +${h.peakDb.toFixed(1)} dB\n`
  );
}
const rate = ((hits.length / usable.length) * 100).toFixed(1);
process.stdout.write(`\n${hits.length} phantom sweeps of ${usable.length} (${rate}%)\n`);
if (statuses.length) {
  const last = statuses[statuses.length - 1];
  process.stdout.write(
    `engine counters: overflows=${last.overflows} zeroRuns=${last.zeroRuns} ` +
      `lateStarts=${last.lateStarts ?? 'n/a'} captureTimeouts=${last.captureTimeouts} recals=${last.recals}\n`
  );
}
process.exit(hits.length > 0 ? 1 : 0);
