#!/usr/bin/env node
// A sweep on a page, for looking at with your eyes.
//
//   npm run viewer -- [--start 470 --stop 608 --rbw 25 --gain 40 --interleave --no-image-reject]
//   npm run viewer -- --file capture.frames        replay a `engine --record` capture
//
// This is a debug tool, not part of the plugin: SoundBase never sees it, and
// nothing here is the contract's HTTP. Live mode drives the radio through the
// plugin's own EngineClient, so what it draws came down the same path the
// plugin uses. The point of it is the lower plot — the p10 floor and the
// whole-trace median, each on its own dB axis, with gain, over the last few
// hundred sweeps and the sweeps the engine flagged marked — which is where a
// level that moves between sweeps becomes visible as a shape rather than a
// column of numbers. The two are kept apart because they mean different
// things: p10 is the receiver's own floor, and in a band full of DTV the
// median is the DTV level, which fades with the air (2026-09-20). A single
// "floor" line that was really the median drew that fading and blamed the
// radio for it.

import { createReadStream } from 'node:fs';
import http from 'node:http';
import { EngineClient } from '../driver/engine-client.js';
import {
  FrameReassembler,
  Flags,
  MaskBit,
  MsgType,
  decodeFrame,
  liveTrace,
  maskOf,
} from '../driver/frames.js';
import { deviceArgsFor, resolveEngineBinary, BUILD_HINT } from '../driver/locate.js';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const value = (name, fallback) => {
  const i = argv.indexOf(name);
  return i === -1 ? fallback : argv[i + 1];
};
const num = (name, fallback) => {
  const v = value(name, undefined);
  return v === undefined ? fallback : Number(v);
};

const PORT = num('--port', 8123);
const FILE = value('--file', undefined);
// The envelope is reduced to this many columns before it is sent. A sweep is
// thousands of cells and a screen is not, so the reduction has to happen
// somewhere; doing it here keeps each update small enough to send every sweep.
const COLUMNS = 1200;
const HISTORY = 400;

const FLAG_LETTERS = [
  ['gainChanged', 'G'],
  ['clipped', 'C'],
  ['recalHappened', 'R'],
  ['overflowSeen', 'O'],
  ['interleaveParity', 'i'],
  ['uncalibrated', 'u'],
];

const round = (v, n = 1) => (Number.isFinite(v) ? Number(v.toFixed(n)) : null);

function percentile(sorted, p) {
  if (sorted.length === 0) return NaN;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

/** Everything the page needs about one sweep, already reduced to screen width. */
function summarise(frame) {
  const trace = liveTrace(frame);
  const mask = maskOf(frame);
  const values = trace?.values ?? [];
  const n = values.length;
  const mins = new Array(COLUMNS).fill(null);
  const maxs = new Array(COLUMNS).fill(null);
  const held = new Array(COLUMNS).fill(0);

  for (let x = 0; x < COLUMNS; x += 1) {
    const a = Math.floor((x * n) / COLUMNS);
    const b = Math.max(a + 1, Math.floor(((x + 1) * n) / COLUMNS));
    let lo = Infinity;
    let hi = -Infinity;
    let heldCells = 0;
    let cells = 0;
    for (let i = a; i < b && i < n; i += 1) {
      cells += 1;
      const v = values[i];
      if (Number.isFinite(v)) {
        const dbm = v + frame.kDbm;
        if (dbm < lo) lo = dbm;
        if (dbm > hi) hi = dbm;
      }
      // Cells the engine filled from the previous sweep rather than measuring.
      if (mask && mask[i] & (MaskBit.interpolated | MaskBit.hole)) heldCells += 1;
    }
    mins[x] = lo === Infinity ? null : round(lo);
    maxs[x] = hi === -Infinity ? null : round(hi);
    held[x] = cells === 0 ? 0 : heldCells / cells;
  }

  const finite = [];
  for (const v of values) if (Number.isFinite(v)) finite.push(v + frame.kDbm);
  finite.sort((a, b) => a - b);

  let interp = 0;
  let hole = 0;
  for (const m of mask ?? []) {
    if (m & MaskBit.interpolated) interp += 1;
    if (m & MaskBit.hole) hole += 1;
  }

  return {
    sweepId: frame.sweepId,
    tDeviceS: round(frame.tDeviceS, 3),
    gainDb: round(frame.gainDb, 0),
    kDbm: round(frame.kDbm),
    startHz: frame.startHz,
    stepHz: frame.stepHz,
    binCount: frame.binCount,
    flags: FLAG_LETTERS.filter(([name]) => frame.flags & Flags[name]).map(([, l]) => l).join('') || '-',
    gainChanged: Boolean(frame.flags & Flags.gainChanged),
    medianDbm: round(percentile(finite, 0.5)),
    p10Dbm: round(percentile(finite, 0.1)),
    interp,
    hole,
    mins,
    maxs,
    held: held.map((h) => round(h, 2)),
  };
}

// ---------------------------------------------------------------------------
// State the page reads

const state = { latest: null, history: [], status: null, mode: FILE ? 'replay' : 'live', total: 0 };
const listeners = new Set();

function publish(summary) {
  state.latest = summary;
  state.history.push({
    sweepId: summary.sweepId,
    t: summary.tDeviceS,
    gainDb: summary.gainDb,
    medianDbm: summary.medianDbm,
    p10Dbm: summary.p10Dbm,
    gainChanged: summary.gainChanged,
    flags: summary.flags,
  });
  if (state.history.length > HISTORY) state.history.shift();
  const payload = `data: ${JSON.stringify({ sweep: summary, status: state.status })}\n\n`;
  for (const res of listeners) res.write(payload);
}

// ---------------------------------------------------------------------------
// Sources

const replay = [];

async function loadCapture(file) {
  const reassembler = new FrameReassembler((raw) => {
    const frame = decodeFrame(raw);
    if (frame.msgType === MsgType.Status && frame.json?.type === 'status') state.status = frame.json;
    if (frame.msgType !== MsgType.TraceComplete) return;
    replay.push(summarise(frame));
  });
  for await (const chunk of createReadStream(file)) reassembler.push(chunk);
  state.total = replay.length;
  // The history plot covers the whole capture, so the shape is there on arrival.
  state.history = replay.map((s) => ({
    sweepId: s.sweepId, t: s.tDeviceS, gainDb: s.gainDb,
    medianDbm: s.medianDbm, p10Dbm: s.p10Dbm, gainChanged: s.gainChanged, flags: s.flags,
  }));
  state.latest = replay[0] ?? null;
  process.stderr.write(`${replay.length} sweeps from ${file}\n`);
}

let engine = null;

async function startLive() {
  const pluginConfig = {};
  const binPath = resolveEngineBinary(pluginConfig);
  if (!binPath) {
    process.stderr.write(`no sweep engine binary: ${BUILD_HINT}\n`);
    process.exit(1);
  }
  engine = new EngineClient({
    binPath,
    deviceArgs: value('--serial', undefined) ? deviceArgsFor(value('--serial')) : 'type=b200',
    tag: 'viewer',
    log: ({ level, msg }) => process.stderr.write(`[engine ${level}] ${msg}\n`),
  });
  engine.onSweep = (frame) => publish(summarise(frame));
  engine.onStatus = (status) => { state.status = status; };
  engine.onFatal = (reason) => {
    process.stderr.write(`engine died: ${reason}\n`);
    process.exit(1);
  };
  await engine.start();

  const plan = {
    startHz: num('--start', 470) * 1e6,
    stopHz: num('--stop', 608) * 1e6,
    rbwHz: num('--rbw', 25) * 1e3,
  };
  if (argv.includes('--vbw')) plan.vbwHz = num('--vbw') * 1e3;
  if (argv.includes('--gain')) { plan.gainDb = num('--gain'); plan.gainMode = 'manual'; }
  if (argv.includes('--ref')) plan.refLevelDbm = num('--ref');
  if (argv.includes('--dwell')) plan.dwell = value('--dwell');
  if (argv.includes('--detector')) plan.detector = value('--detector');
  if (flag('--interleave')) plan.interleave = true;
  // Same default as the plugin, so the viewer shows what SoundBase sees;
  // --no-image-reject shows the raw engine.
  plan.imageReject = !flag('--no-image-reject');
  const applied = await engine.setPlan(plan);
  process.stderr.write(`applied: ${JSON.stringify(applied.applied ?? applied)}\n`);
  engine.send({ cmd: 'start' });
}

// ---------------------------------------------------------------------------
// The page. Kept in one string on purpose: a debug tool that is one file is a
// debug tool that still runs in six months.

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>sweep viewer</title>
<style>
  :root { color-scheme: dark; --bg:#0e1116; --panel:#161b22; --line:#30363d; --text:#e6edf3; --dim:#8b949e;
          --trace:#58d6a0; --ref:#6e7681; --gain:#f0a04b; --floor:#58a6ff; --median:#d2a8ff; --held:#f85149; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font:13px ui-monospace,SFMono-Regular,Menlo,monospace; }
  header { display:flex; flex-wrap:wrap; gap:14px; align-items:center; padding:8px 12px;
           background:var(--panel); border-bottom:1px solid var(--line); }
  .stat b { color:var(--dim); font-weight:normal; }
  .stat span { color:var(--text); }
  .flagged { color:var(--held); font-weight:bold; }
  button { background:#21262d; color:var(--text); border:1px solid var(--line); border-radius:5px;
           padding:4px 10px; cursor:pointer; font:inherit; }
  button.on { border-color:var(--trace); color:var(--trace); }
  main { padding:12px; display:flex; flex-direction:column; gap:12px; }
  canvas { width:100%; display:block; background:var(--panel); border:1px solid var(--line); border-radius:6px; }
  /* The height must come from CSS: fit() writes the attribute height, and with no CSS height
     that would feed straight back into layout and grow the canvas on every frame. */
  #spec { height:420px; }
  #hist { height:300px; }
  #scrub { width:100%; }
  .hint { color:var(--dim); }
</style>
</head>
<body>
<header>
  <div class="stat"><b>sweep</b> <span id="sweepId">-</span></div>
  <div class="stat"><b>gain</b> <span id="gain">-</span> dB</div>
  <div class="stat"><b>K</b> <span id="k">-</span></div>
  <div class="stat"><b>flags</b> <span id="flags">-</span></div>
  <div class="stat"><b>floor p10</b> <span id="p10">-</span> dBm</div>
  <div class="stat"><b>median</b> <span id="median">-</span> dBm</div>
  <div class="stat"><b>held cells</b> <span id="held">-</span></div>
  <div class="stat"><b>rate</b> <span id="rate">-</span>/s</div>
  <button id="pause">pause</button>
  <button id="ref">hold reference</button>
  <button id="clear">clear history</button>
  <span class="hint" id="mode"></span>
</header>
<main>
  <canvas id="spec" height="420"></canvas>
  <input id="scrub" type="range" min="0" max="0" value="0" hidden>
  <canvas id="hist" height="300"></canvas>
</main>
<script>
const $ = (id) => document.getElementById(id);
let sweep = null, history = [], reference = null, paused = false, mode = 'live', total = 0;
let lo = -120, hi = -20;

function fit(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}

function css(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

function drawSpectrum() {
  const { ctx, w, h } = fit($('spec'));
  ctx.clearRect(0, 0, w, h);
  if (!sweep) return;
  const padL = 52, padR = 10, padT = 10, padB = 26;
  const plotW = w - padL - padR, plotH = h - padT - padB;

  // Ease the dB window towards the data so the trace does not jump every sweep.
  const vals = sweep.maxs.filter((v) => v !== null);
  if (vals.length) {
    const mn = Math.min(...sweep.mins.filter((v) => v !== null));
    const mx = Math.max(...vals);
    lo += ((mn - 8) - lo) * 0.1;
    hi += ((mx + 8) - hi) * 0.1;
  }
  const y = (db) => padT + plotH * (1 - (db - lo) / (hi - lo));
  const x = (i) => padL + (plotW * i) / (sweep.maxs.length - 1);

  ctx.strokeStyle = css('--line'); ctx.fillStyle = css('--dim'); ctx.lineWidth = 1;
  ctx.font = '11px ui-monospace, monospace'; ctx.textAlign = 'right';
  for (let d = Math.ceil(lo / 10) * 10; d <= hi; d += 10) {
    const yy = Math.round(y(d)) + 0.5;
    ctx.globalAlpha = 0.35; ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(w - padR, yy); ctx.stroke();
    ctx.globalAlpha = 1; ctx.fillText(d + '', padL - 6, yy + 3);
  }
  const startMHz = sweep.startHz / 1e6, spanMHz = (sweep.stepHz * sweep.binCount) / 1e6;
  ctx.textAlign = 'center';
  for (let t = 0; t <= 6; t += 1) {
    const xx = padL + (plotW * t) / 6;
    ctx.fillText((startMHz + (spanMHz * t) / 6).toFixed(1), xx, h - 8);
  }

  // Cells the engine carried over from the previous sweep rather than measuring.
  ctx.fillStyle = css('--held');
  for (let i = 0; i < sweep.held.length; i += 1) {
    if (sweep.held[i] > 0) {
      ctx.globalAlpha = Math.min(0.85, 0.25 + sweep.held[i]);
      ctx.fillRect(x(i), padT + plotH - 4, Math.max(1, plotW / sweep.held.length), 4);
    }
  }
  ctx.globalAlpha = 1;

  if (reference) drawTrace(ctx, reference, x, y, css('--ref'), false);
  drawTrace(ctx, sweep, x, y, css('--trace'), true);
}

function drawTrace(ctx, s, x, y, colour, fill) {
  if (fill) {
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < s.maxs.length; i += 1) {
      if (s.maxs[i] === null) continue;
      if (!started) { ctx.moveTo(x(i), y(s.maxs[i])); started = true; } else ctx.lineTo(x(i), y(s.maxs[i]));
    }
    for (let i = s.mins.length - 1; i >= 0; i -= 1) {
      if (s.mins[i] === null) continue;
      ctx.lineTo(x(i), y(s.mins[i]));
    }
    ctx.closePath(); ctx.globalAlpha = 0.28; ctx.fillStyle = colour; ctx.fill(); ctx.globalAlpha = 1;
  }
  ctx.beginPath();
  let started = false;
  for (let i = 0; i < s.maxs.length; i += 1) {
    if (s.maxs[i] === null) continue;
    if (!started) { ctx.moveTo(x(i), y(s.maxs[i])); started = true; } else ctx.lineTo(x(i), y(s.maxs[i]));
  }
  ctx.strokeStyle = colour; ctx.lineWidth = 1.2; ctx.stroke();
}

function drawHistory() {
  const { ctx, w, h } = fit($('hist'));
  ctx.clearRect(0, 0, w, h);
  if (history.length < 2) return;
  const padL = 52, padR = 46, padT = 12, padB = 20, gap = 16;
  const plotW = w - padL - padR, stripH = (h - padT - padB - gap) / 2;
  const x = (i) => padL + (plotW * i) / (history.length - 1);
  const present = (v) => v !== null && v !== undefined;
  const gains = history.map((p) => p.gainDb).filter(present);
  const gLo = Math.min(...gains) - 2, gHi = Math.max(...gains) + 2;
  ctx.font = '11px ui-monospace, monospace';
  // Two strips on separate dB axes. p10 is the receiver's floor and barely moves; the
  // whole-trace median is the level of whatever fills most of the band, DTV here, and
  // fades with the air. On one shared axis the 20 dB between them would hide a 1 dB
  // movement of either, and that movement is what this plot exists to show.
  const strips = [
    { key: 'p10Dbm', label: 'floor p10', colour: css('--floor'), top: padT },
    { key: 'medianDbm', label: 'median', colour: css('--median'), top: padT + stripH + gap },
  ];
  for (const s of strips) {
    const vals = history.map((p) => p[s.key]).filter(present);
    if (vals.length < 2) continue;
    const lo = Math.min(...vals) - 1, hi = Math.max(...vals) + 1;
    const y = (v) => s.top + stripH * (1 - (v - lo) / Math.max(0.5, hi - lo));
    const yG = (v) => s.top + stripH * (1 - (v - gLo) / Math.max(0.5, gHi - gLo));
    // Every sweep the engine said it changed gain on: the line to read the level against.
    ctx.strokeStyle = css('--held'); ctx.globalAlpha = 0.5; ctx.lineWidth = 1;
    history.forEach((p, i) => {
      if (!p.gainChanged) return;
      ctx.beginPath(); ctx.moveTo(x(i), s.top); ctx.lineTo(x(i), s.top + stripH); ctx.stroke();
    });
    ctx.globalAlpha = 1;
    ctx.beginPath();
    history.forEach((p, i) => (i ? ctx.lineTo(x(i), yG(p.gainDb)) : ctx.moveTo(x(i), yG(p.gainDb))));
    ctx.strokeStyle = css('--gain'); ctx.lineWidth = 1; ctx.stroke();
    ctx.beginPath();
    let started = false;
    history.forEach((p, i) => {
      const v = p[s.key];
      if (!present(v)) return;
      if (!started) { ctx.moveTo(x(i), y(v)); started = true; } else ctx.lineTo(x(i), y(v));
    });
    ctx.strokeStyle = s.colour; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.textAlign = 'right'; ctx.fillStyle = s.colour;
    ctx.fillText(hi.toFixed(1), padL - 6, s.top + 4);
    ctx.fillText(lo.toFixed(1), padL - 6, s.top + stripH);
    ctx.textAlign = 'left';
    ctx.fillText(s.label + ', moved ' + (hi - lo - 2).toFixed(1) + ' dB', padL + 4, s.top + 10);
    ctx.fillStyle = css('--gain');
    ctx.fillText(gHi.toFixed(0) + ' dB', w - padR + 6, s.top + 4);
    ctx.fillText(gLo.toFixed(0) + ' dB', w - padR + 6, s.top + stripH);
  }
  ctx.fillStyle = css('--dim'); ctx.textAlign = 'center';
  ctx.fillText('floor p10 (blue) and whole-trace median (violet) on their own axes, gain (orange), over the last '
               + history.length + ' sweeps; red = gain changed', padL + plotW / 2, h - 5);
}

function show(s) {
  sweep = s;
  $('sweepId').textContent = s.sweepId;
  $('gain').textContent = s.gainDb;
  $('k').textContent = s.kDbm;
  $('flags').textContent = s.flags;
  $('flags').className = s.flags === '-' || s.flags === 'u' ? '' : 'flagged';
  $('p10').textContent = s.p10Dbm;
  $('median').textContent = s.medianDbm;
  $('held').textContent = s.interp + ' interp / ' + s.hole + ' hole';
  drawSpectrum(); drawHistory();
}

$('pause').onclick = (e) => { paused = !paused; e.target.classList.toggle('on', paused); };
$('ref').onclick = (e) => {
  reference = reference ? null : sweep;
  e.target.classList.toggle('on', Boolean(reference));
  drawSpectrum();
};
$('clear').onclick = () => { history = []; drawHistory(); };
window.addEventListener('resize', () => { drawSpectrum(); drawHistory(); });

async function boot() {
  const st = await (await fetch('/api/state')).json();
  mode = st.mode; total = st.total; history = st.history || [];
  $('mode').textContent = mode === 'replay' ? 'replay, ' + total + ' sweeps' : 'live';
  if (st.sweep) show(st.sweep);
  if (mode === 'replay') {
    const scrub = $('scrub');
    scrub.hidden = false; scrub.max = Math.max(0, total - 1);
    scrub.oninput = async () => {
      const r = await (await fetch('/api/sweep?i=' + scrub.value)).json();
      if (r.sweep) show(r.sweep);
    };
    return;
  }
  const es = new EventSource('/events');
  es.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.status) $('rate').textContent = (msg.status.sweepsPerSec || 0).toFixed(1);
    if (paused) return;
    history.push({ sweepId: msg.sweep.sweepId, gainDb: msg.sweep.gainDb,
                   p10Dbm: msg.sweep.p10Dbm, medianDbm: msg.sweep.medianDbm,
                   gainChanged: msg.sweep.gainChanged });
    if (history.length > 400) history.shift();
    show(msg.sweep);
  };
}
boot();
</script>
</body>
</html>`;

// ---------------------------------------------------------------------------
// Server

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PAGE);
    return;
  }
  if (url.pathname === '/api/state') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      mode: state.mode, total: state.total, status: state.status,
      sweep: state.latest, history: state.history,
    }));
    return;
  }
  if (url.pathname === '/api/sweep') {
    const i = Number(url.searchParams.get('i') ?? 0);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ sweep: replay[Math.max(0, Math.min(replay.length - 1, i))] ?? null }));
    return;
  }
  if (url.pathname === '/events') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    res.write('\n');
    listeners.add(res);
    req.on('close', () => listeners.delete(res));
    return;
  }
  res.writeHead(404).end('not found');
});

async function shutdown() {
  for (const res of listeners) res.end();
  server.close();
  await engine?.stop().catch(() => {});
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

if (FILE) await loadCapture(FILE);
server.listen(PORT, '127.0.0.1', () => {
  process.stderr.write(`sweep viewer on http://127.0.0.1:${PORT}  (${state.mode})\n`);
});
if (!FILE) await startLive();
