// The engine's binary frame format, in JavaScript.
//
// One frame is `u32 length` followed by a 64-byte header and then either trace
// blocks (msgType 1/2) or a UTF-8 JSON body (msgType 3/4). Everything is
// little-endian. This is a port of the codec the C++ engine writes; the golden
// frames in __tests__/fixtures were produced by that encoder and are decoded
// here by a test, which is what keeps the two honest.
//
// The full specification is engine/README.md and the protocol section of
// docs/engine-protocol.md. Only what the plugin needs is implemented: decoding
// everything, and encoding enough for the fake engine to be indistinguishable
// from the real one on the wire.

export const MAGIC = 0x53;
export const VERSION = 1;
export const HEADER_BYTES = 64;
export const TRACE_HEADER_BYTES = 8;
export const LENGTH_PREFIX_BYTES = 4;

export const MsgType = {
  TraceComplete: 1,
  TracePartial: 2,
  Status: 3,
  Log: 4,
};

export const Flags = {
  sweepComplete: 1 << 0,
  overflowSeen: 1 << 1,
  clipped: 1 << 2,
  recalHappened: 1 << 3,
  usb2: 1 << 4,
  uncalibrated: 1 << 5,
  interleaveParity: 1 << 6,
  gainChanged: 1 << 7,
};

export const MaskBit = {
  hole: 1,
  interpolated: 2,
  spur: 4,
  overflowInvalid: 8,
  clipped: 16,
  imageSuspect: 32,
  loHole: 64,
};

/** Which detector produced a trace block. */
export const Detector = { rms: 0, peak: 1, sample: 2, min: 3, na: 255 };

/** What a trace block is. The plugin only ever reads the live kinds. */
export const TraceKind = {
  liveAvg: 0,
  livePeak: 1,
  maxHold: 2,
  minHold: 3,
  avg: 4,
  mask: 5,
  liveMin: 6,
  liveSample: 7,
};

/** The live trace each detector setting produces. */
export const LIVE_KIND_FOR_DETECTOR = {
  rms: TraceKind.liveAvg,
  peak: TraceKind.livePeak,
  sample: TraceKind.liveSample,
  min: TraceKind.liveMin,
};

export class FrameError extends Error {
  name = 'FrameError';
}

const padTo4 = (n) => (n + 3) & ~3;
const viewOf = (buf) => new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
const isJsonType = (msgType) =>
  msgType === MsgType.Status || msgType === MsgType.Log;

export const hasFlag = (flags, name) => (flags & Flags[name]) !== 0;

/** Reads `frameLength` out of a header without decoding the rest. */
export function frameLengthFromHeader(buf) {
  if (buf.byteLength < 52)
    throw new FrameError('header too short for frameLength');
  return viewOf(buf).getUint32(48, true);
}

export function decodeHeader(buf) {
  if (buf.byteLength < HEADER_BYTES) {
    throw new FrameError(`buffer too short: ${buf.byteLength} < ${HEADER_BYTES}`);
  }
  const dv = viewOf(buf);
  const magic = dv.getUint8(0);
  if (magic !== MAGIC)
    throw new FrameError(`bad magic 0x${magic.toString(16)}`);
  const version = dv.getUint8(1);
  if (version !== VERSION)
    throw new FrameError(`unsupported protocol version ${version}`);
  return {
    msgType: dv.getUint8(2),
    dtype: dv.getUint8(3),
    flags: dv.getUint16(4, true),
    traceCount: dv.getUint8(6),
    sweepId: dv.getUint32(8, true),
    seq: dv.getUint32(12, true),
    startHz: dv.getFloat64(16, true),
    stepHz: dv.getFloat64(24, true),
    tDeviceS: dv.getFloat64(32, true),
    binCount: dv.getUint32(40, true),
    rbwHz: dv.getFloat32(44, true),
    frameLength: dv.getUint32(48, true),
    gainDb: dv.getFloat32(52, true),
    // dBm = trace value + kDbm: the input power that produces 0 dBFS.
    kDbm: dv.getFloat32(56, true),
    navg: dv.getUint16(60, true),
    profileId: dv.getUint16(62, true),
  };
}

/**
 * Decodes a whole frame. `buf` may be longer than `frameLength`; trailing bytes
 * are ignored. Value payloads become `Float32Array` views when the buffer is
 * 4-byte aligned, which is why the reassembler hands out fresh buffers.
 */
export function decodeFrame(buf) {
  const header = decodeHeader(buf);
  if (header.frameLength < HEADER_BYTES) {
    throw new FrameError(`frameLength ${header.frameLength} < header`);
  }
  if (header.frameLength > buf.byteLength) {
    throw new FrameError(
      `frameLength ${header.frameLength} exceeds buffer ${buf.byteLength}`
    );
  }
  const frame = { ...header, traces: [] };

  if (isJsonType(header.msgType)) {
    const body = buf.subarray(HEADER_BYTES, header.frameLength);
    const text = new TextDecoder().decode(body);
    try {
      frame.json = text.length === 0 ? undefined : JSON.parse(text);
    } catch (err) {
      throw new FrameError(`invalid JSON body: ${err.message}`);
    }
    return frame;
  }
  if (header.dtype !== 0) {
    throw new FrameError(`unsupported dtype ${header.dtype}`);
  }

  const dv = viewOf(buf);
  let off = HEADER_BYTES;
  for (let t = 0; t < header.traceCount; t += 1) {
    if (off + TRACE_HEADER_BYTES > header.frameLength) {
      throw new FrameError(`trace ${t} sub-header overruns frame`);
    }
    const trace = {
      detector: dv.getUint8(off),
      kind: dv.getUint8(off + 1),
      avgCount: dv.getUint16(off + 2, true),
      filledBins: dv.getUint32(off + 4, true),
    };
    off += TRACE_HEADER_BYTES;
    if (trace.kind === TraceKind.mask) {
      const end = off + padTo4(header.binCount);
      if (end > header.frameLength) {
        throw new FrameError(`trace ${t} mask payload overruns frame`);
      }
      trace.mask = buf.slice(off, off + header.binCount);
      off = end;
    } else {
      const bytes = header.binCount * 4;
      if (off + bytes > header.frameLength) {
        throw new FrameError(`trace ${t} payload overruns frame`);
      }
      const abs = buf.byteOffset + off;
      if (abs % 4 === 0) {
        trace.values = new Float32Array(buf.buffer, abs, header.binCount);
      } else {
        const copy = new Uint8Array(bytes);
        copy.set(buf.subarray(off, off + bytes));
        trace.values = new Float32Array(copy.buffer, 0, header.binCount);
      }
      off += bytes;
    }
    frame.traces.push(trace);
  }
  return frame;
}

/** The value trace a given detector produces, or the first one that exists. */
export function liveTrace(frame, detector = 'rms') {
  const wanted = LIVE_KIND_FOR_DETECTOR[detector];
  return (
    frame.traces.find((t) => t.kind === wanted && t.values) ??
    frame.traces.find(
      (t) => t.kind !== TraceKind.mask && t.values && t.kind <= TraceKind.livePeak
    ) ??
    frame.traces.find((t) => t.kind !== TraceKind.mask && t.values)
  );
}

export function maskOf(frame) {
  return frame.traces.find((t) => t.kind === TraceKind.mask)?.mask;
}

/**
 * Encodes a frame (f32 traces only). Used by the fake engine and by the codec
 * round-trip test; the real engine never sends anything this produces.
 */
export function encodeFrame(frame) {
  if (isJsonType(frame.msgType)) {
    const body = new TextEncoder().encode(
      frame.json === undefined ? '' : JSON.stringify(frame.json)
    );
    const out = new Uint8Array(HEADER_BYTES + body.byteLength);
    writeHeader(new DataView(out.buffer), { ...frame, binCount: 0 }, 0, out.byteLength);
    out.set(body, HEADER_BYTES);
    return out;
  }
  const traces = frame.traces ?? [];
  let total = HEADER_BYTES;
  for (const t of traces) {
    total +=
      TRACE_HEADER_BYTES +
      (t.kind === TraceKind.mask ? padTo4(frame.binCount) : frame.binCount * 4);
  }
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  writeHeader(dv, frame, traces.length, total);
  let off = HEADER_BYTES;
  for (const t of traces) {
    dv.setUint8(off, t.detector);
    dv.setUint8(off + 1, t.kind);
    dv.setUint16(off + 2, Math.min(t.avgCount ?? 0, 0xffff), true);
    dv.setUint32(off + 4, (t.filledBins ?? frame.binCount) >>> 0, true);
    off += TRACE_HEADER_BYTES;
    if (t.kind === TraceKind.mask) {
      out.set(t.mask, off);
      off += padTo4(frame.binCount);
    } else {
      new Float32Array(out.buffer, off, frame.binCount).set(t.values);
      off += frame.binCount * 4;
    }
  }
  return out;
}

function writeHeader(dv, h, traceCount, frameLength) {
  dv.setUint8(0, MAGIC);
  dv.setUint8(1, VERSION);
  dv.setUint8(2, h.msgType);
  dv.setUint8(3, h.dtype ?? 0);
  dv.setUint16(4, h.flags ?? 0, true);
  dv.setUint8(6, traceCount);
  dv.setUint8(7, 0);
  dv.setUint32(8, (h.sweepId ?? 0) >>> 0, true);
  dv.setUint32(12, (h.seq ?? 0) >>> 0, true);
  dv.setFloat64(16, h.startHz ?? 0, true);
  dv.setFloat64(24, h.stepHz ?? 0, true);
  dv.setFloat64(32, h.tDeviceS ?? 0, true);
  dv.setUint32(40, (h.binCount ?? 0) >>> 0, true);
  dv.setFloat32(44, h.rbwHz ?? 0, true);
  dv.setUint32(48, frameLength >>> 0, true);
  dv.setFloat32(52, h.gainDb ?? 0, true);
  dv.setFloat32(56, h.kDbm ?? 0, true);
  dv.setUint16(60, h.navg ?? 0, true);
  dv.setUint16(62, h.profileId ?? 0, true);
}

/** Prefix a frame with its u32 little-endian length — the socket record format. */
export function lengthPrefixed(raw) {
  const out = Buffer.allocUnsafe(LENGTH_PREFIX_BYTES + raw.byteLength);
  out.writeUInt32LE(raw.byteLength, 0);
  out.set(raw, LENGTH_PREFIX_BYTES);
  return out;
}

/**
 * Turns an arbitrarily chunked byte stream of length-prefixed records into whole
 * frames. Each frame is copied into a fresh, 4-byte-aligned buffer so the
 * decoder can take zero-copy views of the f32 payloads.
 */
export class FrameReassembler {
  #chunks = [];
  #headOffset = 0;
  #buffered = 0;

  constructor(onFrame, { maxFrameBytes = 64 * 1024 * 1024 } = {}) {
    this.onFrame = onFrame;
    this.maxFrameBytes = maxFrameBytes;
  }

  reset() {
    this.#chunks = [];
    this.#headOffset = 0;
    this.#buffered = 0;
  }

  push(chunk) {
    if (chunk.length === 0) return;
    this.#chunks.push(chunk);
    this.#buffered += chunk.length;
    for (;;) {
      if (this.#buffered < LENGTH_PREFIX_BYTES) return;
      const len = this.#peekU32();
      if (len < HEADER_BYTES || len > this.maxFrameBytes) {
        this.reset();
        throw new FrameError(`implausible frame length ${len}`);
      }
      if (this.#buffered < LENGTH_PREFIX_BYTES + len) return;
      this.#skip(LENGTH_PREFIX_BYTES);
      const raw = this.#take(len);
      if (raw[0] !== MAGIC) {
        this.reset();
        throw new FrameError(`bad magic 0x${raw[0]?.toString(16)}`);
      }
      const declared = frameLengthFromHeader(raw);
      if (declared !== len) {
        this.reset();
        throw new FrameError(
          `length prefix ${len} does not match frameLength ${declared}`
        );
      }
      this.onFrame(raw);
    }
  }

  #peekU32() {
    let value = 0;
    let ci = 0;
    let off = this.#headOffset;
    for (let i = 0; i < 4; i += 1) {
      let c = this.#chunks[ci];
      while (off >= c.length) {
        ci += 1;
        off = 0;
        c = this.#chunks[ci];
      }
      value |= c[off] << (8 * i);
      off += 1;
    }
    return value >>> 0;
  }

  #skip(n) {
    let remaining = n;
    while (remaining > 0) {
      const c = this.#chunks[0];
      const avail = c.length - this.#headOffset;
      if (avail <= remaining) {
        remaining -= avail;
        this.#chunks.shift();
        this.#headOffset = 0;
      } else {
        this.#headOffset += remaining;
        remaining = 0;
      }
    }
    this.#buffered -= n;
  }

  #take(n) {
    const out = Buffer.from(new ArrayBuffer(n));
    let written = 0;
    while (written < n) {
      const c = this.#chunks[0];
      const avail = c.length - this.#headOffset;
      const want = Math.min(avail, n - written);
      c.copy(out, written, this.#headOffset, this.#headOffset + want);
      written += want;
      if (want === avail) {
        this.#chunks.shift();
        this.#headOffset = 0;
      } else {
        this.#headOffset += want;
      }
    }
    this.#buffered -= n;
    return out;
  }
}
