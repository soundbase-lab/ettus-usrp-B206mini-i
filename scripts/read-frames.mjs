#!/usr/bin/env node
// Reads a capture written by `engine --record FILE.frames` and prints one row per sweep.
//
//   node scripts/read-frames.mjs FILE.frames [--from N] [--to N] [--csv]
//
// The file is the engine's socket stream byte for byte, so it is decoded by the
// plugin's own codec — nothing here knows the format independently. The columns
// are the three things that move a noise floor between consecutive sweeps:
// the gain the sweep was taken at, the flags the engine raised for it, and how
// many cells carry values held over from the previous sweep rather than
// measured in this one. The two level columns are the whole-trace median and
// p10. The median is the level of whatever fills most of the band — DTV, in
// UHF — and fades with the air; p10 is the floor.

import { createReadStream } from 'node:fs';
import {
  FrameReassembler,
  Flags,
  MaskBit,
  MsgType,
  decodeFrame,
  liveTrace,
  maskOf,
} from '../driver/frames.js';

const argv = process.argv.slice(2);
const file = argv.find((a) => !a.startsWith('--'));
if (!file) {
  process.stderr.write('usage: read-frames.mjs FILE.frames [--from N] [--to N] [--csv]\n');
  process.exit(2);
}
const numeric = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : Number(argv[i + 1]);
};
const from = numeric('--from') ?? 0;
const to = numeric('--to') ?? Infinity;
const csv = argv.includes('--csv');

// One letter per flag, so a sweep's whole state reads at a glance in the row.
const FLAG_LETTERS = [
  ['gainChanged', 'G'],
  ['clipped', 'C'],
  ['recalHappened', 'R'],
  ['overflowSeen', 'O'],
  ['interleaveParity', 'i'],
  ['uncalibrated', 'u'],
];

function percentile(values, p) {
  if (values.length === 0) return NaN;
  const sorted = Float64Array.from(values).sort();
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

const counts = { traceComplete: 0, tracePartial: 0, status: 0, log: 0 };
let lastStatus;
const rows = [];

const reassembler = new FrameReassembler((raw) => {
  const frame = decodeFrame(raw);
  if (frame.msgType === MsgType.Status) {
    counts.status += 1;
    lastStatus = frame.json;
    return;
  }
  if (frame.msgType === MsgType.Log) {
    counts.log += 1;
    return;
  }
  if (frame.msgType === MsgType.TracePartial) {
    counts.tracePartial += 1;
    return;
  }
  counts.traceComplete += 1;
  if (frame.sweepId < from || frame.sweepId > to) return;

  const trace = liveTrace(frame);
  const mask = maskOf(frame);
  // Values are dBFS; the frame's own kDbm is what refers them to dBm, and it
  // moves with the gain — which is exactly why both belong in the row.
  const dbm = [];
  for (const v of trace?.values ?? []) if (Number.isFinite(v)) dbm.push(v + frame.kDbm);

  let interp = 0;
  let hole = 0;
  for (const m of mask ?? []) {
    if (m & MaskBit.interpolated) interp += 1;
    if (m & MaskBit.hole) hole += 1;
  }

  rows.push({
    sweepId: frame.sweepId,
    tDeviceS: frame.tDeviceS,
    gainDb: frame.gainDb,
    kDbm: frame.kDbm,
    flags: FLAG_LETTERS.filter(([name]) => frame.flags & Flags[name])
      .map(([, letter]) => letter)
      .join('') || '-',
    medianDbm: percentile(dbm, 0.5),
    p10Dbm: percentile(dbm, 0.1),
    interp,
    hole,
    bins: frame.binCount,
    clipFraction: lastStatus?.clipFraction ?? NaN,
    peakDbfs: lastStatus?.peakDbfs ?? NaN,
  });
});

for await (const chunk of createReadStream(file)) reassembler.push(chunk);

const COLUMNS = [
  'sweepId', 'tDeviceS', 'gainDb', 'kDbm', 'flags',
  'medianDbm', 'p10Dbm', 'interp', 'hole', 'bins', 'clipFraction', 'peakDbfs',
];
const fixed = (v, n) => (Number.isFinite(v) ? v.toFixed(n) : 'nan');

if (csv) {
  process.stdout.write(`${COLUMNS.join(',')}\n`);
  for (const r of rows) process.stdout.write(`${COLUMNS.map((c) => r[c]).join(',')}\n`);
} else {
  process.stdout.write(
    'sweep      t(s)  gain   kDbm  flags  median    p10  interp  hole    clip    peak\n'
  );
  let prevMedian;
  for (const r of rows) {
    // The step from the previous sweep is the quantity under investigation, so
    // it is computed here rather than left to the reader's eye.
    const step = prevMedian === undefined ? NaN : r.medianDbm - prevMedian;
    prevMedian = r.medianDbm;
    process.stdout.write(
      `${String(r.sweepId).padStart(5)} ${fixed(r.tDeviceS, 3).padStart(9)} ` +
        `${fixed(r.gainDb, 0).padStart(5)} ${fixed(r.kDbm, 1).padStart(6)} ` +
        `${r.flags.padEnd(6)} ${fixed(r.medianDbm, 1).padStart(7)} ${fixed(r.p10Dbm, 1).padStart(6)} ` +
        `${String(r.interp).padStart(7)} ${String(r.hole).padStart(5)} ` +
        `${fixed(r.clipFraction, 2).padStart(7)} ${fixed(r.peakDbfs, 1).padStart(7)}` +
        `${Math.abs(step) >= 1 ? `   step ${step > 0 ? '+' : ''}${step.toFixed(1)} dB` : ''}\n`
    );
  }
}

process.stderr.write(
  `\n${rows.length} sweeps shown; frames: ${counts.traceComplete} complete, ` +
    `${counts.tracePartial} partial, ${counts.status} status, ${counts.log} log\n`
);
