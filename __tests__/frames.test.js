// The frame codec against frames the C++ engine actually produced.
//
// driver/frames.js is a second implementation of a format whose first
// implementation is in engine/src/protocol.cpp. Two implementations of one
// binary layout drift, and the drift shows up as a trace that looks plausible
// and is wrong — so the fixtures in __tests__/fixtures were written by the
// engine's own encoder (`engine --emit-fixtures`) and are decoded here.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  Detector,
  Flags,
  FrameReassembler,
  MaskBit,
  MsgType,
  TraceKind,
  decodeFrame,
  encodeFrame,
  hasFlag,
  lengthPrefixed,
  liveTrace,
  maskOf,
} from '../driver/frames.js';

const fixture = (name) =>
  Buffer.from(
    readFileSync(new URL(`./fixtures/${name}.hex`, import.meta.url), 'utf8').trim(),
    'hex'
  );

test('a complete trace frame from the engine decodes field for field', () => {
  const frame = decodeFrame(fixture('trace_complete_5bins'));

  assert.equal(frame.msgType, MsgType.TraceComplete);
  assert.equal(frame.sweepId, 7);
  assert.equal(frame.startHz, 470e6);
  assert.equal(frame.stepHz, 25e3);
  assert.equal(frame.binCount, 5);
  assert.equal(frame.rbwHz, 25e3);
  assert.equal(frame.gainDb, 50);
  assert.equal(frame.kDbm, -40);
  assert.equal(frame.profileId, 2);
  assert.ok(hasFlag(frame.flags, 'sweepComplete'));
  assert.ok(hasFlag(frame.flags, 'uncalibrated'));

  assert.equal(frame.traces.length, 3);
  const avg = frame.traces[0];
  assert.equal(avg.detector, Detector.rms);
  assert.equal(avg.kind, TraceKind.liveAvg);
  assert.equal(avg.filledBins, 5);
  assert.deepEqual([...avg.values], [-100, -99.5, -60.25, -101, -100.75]);

  // dBm = dBFS + kDbm: the carrier in cell 2 is at −100.25 dBm.
  assert.equal(avg.values[2] + frame.kDbm, -100.25);

  const mask = maskOf(frame);
  assert.equal(mask.length, 5);
  assert.equal(mask[3], MaskBit.spur | MaskBit.interpolated);
});

test('the detector chooses which live trace the adapter reads', () => {
  const frame = decodeFrame(fixture('trace_complete_5bins'));
  assert.equal(liveTrace(frame, 'rms').kind, TraceKind.liveAvg);
  assert.equal(liveTrace(frame, 'peak').kind, TraceKind.livePeak);
  // a detector this frame does not carry falls back to a live trace rather
  // than to the mask or to nothing
  assert.equal(liveTrace(frame, 'min').kind, TraceKind.liveAvg);
});

test('a partial frame reports how far the sweep has got', () => {
  const frame = decodeFrame(fixture('trace_partial_2of5'));
  assert.equal(frame.msgType, MsgType.TracePartial);
  assert.equal(frame.binCount, 5);
  assert.equal(frame.traces[0].filledBins, 2);
  assert.ok(Number.isNaN(frame.traces[0].values[2]));
  assert.ok(!hasFlag(frame.flags, 'sweepComplete'));
});

test('JSON frames carry the status and log bodies', () => {
  const status = decodeFrame(fixture('status_json'));
  assert.equal(status.msgType, MsgType.Status);
  assert.equal(status.json.type, 'status');
  assert.equal(status.json.engineUp, true);

  const log = decodeFrame(fixture('log_json'));
  assert.equal(log.msgType, MsgType.Log);
  assert.equal(log.json.level, 'info');
  assert.equal(log.json.msg, 'hello');
});

test('what the fake engine encodes is what a decoder reads back', () => {
  const values = Float32Array.from([-100, -80.5, -60.25, -99, -101]);
  const mask = Uint8Array.from([0, 0, MaskBit.spur, 0, 0]);
  const raw = encodeFrame({
    msgType: MsgType.TraceComplete,
    dtype: 0,
    flags: Flags.sweepComplete,
    sweepId: 12,
    seq: 3,
    startHz: 470e6,
    stepHz: 25e3,
    tDeviceS: 2.5,
    binCount: 5,
    rbwHz: 25e3,
    gainDb: 40,
    kDbm: -30,
    navg: 31,
    profileId: 7,
    traces: [
      {
        detector: Detector.rms,
        kind: TraceKind.liveAvg,
        avgCount: 31,
        filledBins: 5,
        values,
      },
      { detector: Detector.na, kind: TraceKind.mask, avgCount: 1, filledBins: 5, mask },
    ],
  });

  const frame = decodeFrame(raw);
  assert.equal(frame.frameLength, raw.byteLength);
  assert.equal(frame.sweepId, 12);
  assert.equal(frame.kDbm, -30);
  assert.deepEqual([...frame.traces[0].values], [...values]);
  assert.deepEqual([...maskOf(frame)], [...mask]);
});

test('frames survive being chopped up by the socket', () => {
  const one = lengthPrefixed(fixture('trace_complete_5bins'));
  const two = lengthPrefixed(fixture('status_json'));
  const stream = Buffer.concat([one, two, one]);

  for (const chunkSize of [1, 3, 64, 4096]) {
    const seen = [];
    const reassembler = new FrameReassembler((raw) => seen.push(decodeFrame(raw)));
    for (let i = 0; i < stream.length; i += chunkSize) {
      reassembler.push(stream.subarray(i, i + chunkSize));
    }
    assert.equal(seen.length, 3, `chunk size ${chunkSize}`);
    assert.deepEqual(
      seen.map((f) => f.msgType),
      [MsgType.TraceComplete, MsgType.Status, MsgType.TraceComplete]
    );
    // the f32 payload has to land 4-byte aligned or the values come back wrong
    assert.equal(seen[0].traces[0].values[2], -60.25);
  }
});

test('a corrupt length prefix is refused rather than mis-parsed', () => {
  const reassembler = new FrameReassembler(() => {
    throw new Error('should not have produced a frame');
  });
  assert.throws(
    () => reassembler.push(Buffer.from([0xff, 0xff, 0xff, 0xff])),
    /implausible frame length/
  );
});
