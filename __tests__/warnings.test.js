// What the radio tells the user, and when.
//
// Two layers: the pure tracker (given the engine's status object, which
// conditions hold, at which severity) and the adapter publishing them through
// the shell-assigned `onWarnings` hook while the fake engine reproduces the
// conditions. The severity choices are the tests' real subject — they are
// what an RF coordinator sees as a colour.

process.env.SB_USRP_MOCK = '1';
process.env.SB_USRP_MOCK_SWEEP_MS = '40';

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  INPUT_CRITICAL_DBM,
  INPUT_WARN_DBM,
  TEMP_CRITICAL_C,
  TEMP_WARN_C,
  WarningTracker,
} from '../driver/warnings.js';

const healthy = (over = {}) => ({
  sweeping: true,
  peakDbfs: -30,
  kDbm: -40,
  clipFraction: 0,
  overflows: 0,
  timeouts: 0,
  captureTimeouts: 0,
  ringFull: 0,
  zeroRuns: 0,
  calibrated: true,
  device: { usbVersion: 3, tempC: 45 },
  plan: { predictedSweepMs: 100 },
  ...over,
});
const ids = (list) => list.map((w) => w.id);
const byId = (list, id) => list.find((w) => w.id === id);

test('a healthy radio has nothing to say', () => {
  const t = new WarningTracker();
  t.onStatus(healthy(), 1000);
  assert.deepEqual(t.current(1000), []);
});

test('input level: warning from −20 dBm, critical at the never-exceed level', () => {
  const t = new WarningTracker();
  t.onStatus(healthy({ peakDbfs: -5, kDbm: -12 }), 0); // −17 dBm
  assert.equal(byId(t.current(0), 'input-level').severity, 'warning');
  t.onStatus(healthy({ peakDbfs: -2, kDbm: -12 }), 0); // −14 dBm
  const critical = byId(t.current(0), 'input-level');
  assert.equal(critical.severity, 'critical');
  assert.match(critical.message, /never-exceed/);
  assert.match(critical.message, new RegExp(String(INPUT_CRITICAL_DBM)));
  assert.ok(INPUT_WARN_DBM < INPUT_CRITICAL_DBM);
});

test('clipping needs two consecutive reports, so a gain change does not flash', () => {
  const t = new WarningTracker();
  t.onStatus(healthy({ clipFraction: 0.2 }), 0);
  assert.equal(byId(t.current(0), 'overload'), undefined);
  t.onStatus(healthy({ clipFraction: 0.2 }), 1000);
  const w = byId(t.current(1000), 'overload');
  assert.equal(w.severity, 'warning');
  assert.match(w.message, /20%/);
  assert.match(w.message, /max-hold/, 'says what it does to the holds');
  t.onStatus(healthy({ clipFraction: 0 }), 2000);
  assert.equal(byId(t.current(2000), 'overload'), undefined, 'clears when it clears');
});

test('USB overflows are judged per second, from the counter delta', () => {
  const t = new WarningTracker();
  t.onStatus(healthy({ overflows: 40 }), 0); // a lifetime count means nothing yet
  assert.equal(byId(t.current(0), 'usb-overflow'), undefined);
  t.onStatus(healthy({ overflows: 43 }), 1000);
  const w = byId(t.current(1000), 'usb-overflow');
  assert.equal(w.severity, 'warning');
  assert.match(w.message, /3 sample overflows/);
  t.onStatus(healthy({ overflows: 43 }), 2000);
  assert.equal(byId(t.current(2000), 'usb-overflow'), undefined);
  // timeouts are the quieter cousin, reported only when overflows are not
  t.onStatus(healthy({ overflows: 43, captureTimeouts: 2 }), 3000);
  assert.equal(byId(t.current(3000), 'link-timeouts')?.severity, 'warning');
});

test('a stall is a critical: status keeps arriving and sweeps do not', () => {
  const t = new WarningTracker();
  t.setSweeping(true, 0);
  t.onStatus(healthy({ plan: { predictedSweepMs: 100 } }), 0);
  t.onSweep(500);
  assert.equal(byId(t.current(1000), 'stalled'), undefined, 'a slow sweep is not a stall');
  const w = byId(t.current(3600), 'stalled'); // > max(3 s, 3× predicted) since the last sweep
  assert.equal(w.severity, 'critical');
  assert.match(w.message, /3 s/);
  t.onSweep(3700);
  assert.equal(byId(t.current(3800), 'stalled'), undefined);
  t.setSweeping(false, 3900);
  assert.equal(byId(t.current(20_000), 'stalled'), undefined, 'not sweeping is not stalled');
});

test('temperature: conservative thresholds, two levels', () => {
  const t = new WarningTracker();
  t.onStatus(healthy({ device: { usbVersion: 3, tempC: TEMP_WARN_C - 1 } }), 0);
  assert.equal(byId(t.current(0), 'temperature'), undefined);
  t.onStatus(healthy({ device: { usbVersion: 3, tempC: TEMP_WARN_C } }), 0);
  assert.equal(byId(t.current(0), 'temperature').severity, 'warning');
  t.onStatus(healthy({ device: { usbVersion: 3, tempC: TEMP_CRITICAL_C } }), 0);
  assert.equal(byId(t.current(0), 'temperature').severity, 'critical');
});

test('the things worth knowing are info, and never degrade to more', () => {
  const t = new WarningTracker();
  t.onStatus(healthy({ calibrated: false, device: { usbVersion: 2, tempC: 40 } }), 0);
  const list = t.current(0);
  assert.deepEqual(ids(list), ['uncalibrated', 'usb2']);
  assert.ok(list.every((w) => w.severity === 'info'));
});

// ---------------------------------------------------------------------------
// through the adapter, against the fake engine

const DEVICE = { id: 'usb:FAKE001', config: {} };

async function openWithWarnings(env) {
  const { createSpectrumAnalyzerAdapter } = await import('../adapter.js');
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  const adapter = createSpectrumAnalyzerAdapter(DEVICE, { mock: true });
  const reports = [];
  adapter.onWarnings = (list) => reports.push(list);
  await adapter.open();
  return {
    adapter,
    reports,
    async until(pred, timeoutMs = 6000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const hit = reports.find(pred);
        if (hit) return hit;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error(`no report matched; got ${JSON.stringify(reports.at(-1) ?? null)}`);
    },
    close: async () => {
      for (const k of Object.keys(env)) delete process.env[k];
      await adapter.close();
    },
  };
}

test('an overloaded radio reports overload and input level through onWarnings', async () => {
  const session = await openWithWarnings({ SB_USRP_MOCK_OVERLOAD: '1' });
  try {
    const list = await session.until((l) => l.some((w) => w.id === 'overload'));
    assert.ok(byId(list, 'input-level'), 'the hot input is reported alongside the clipping');
    // uncalibrated is the fake's normal state, so it is there too — as info
    assert.equal(byId(list, 'uncalibrated').severity, 'info');
    assert.ok(list.every((w) => typeof w.message === 'string' && w.message.length > 20));
  } finally {
    await session.close();
  }
});

test('a radio that stops sweeping mid-scan is reported as stalled, not as dead', async () => {
  process.env.SB_USRP_MOCK_SWEEP_MS = '40';
  const session = await openWithWarnings({ SB_USRP_MOCK_STALL_AFTER_MS: '300' });
  try {
    await session.adapter.startSweep(() => {});
    const list = await session.until((l) => l.some((w) => w.id === 'stalled'), 8000);
    assert.equal(byId(list, 'stalled').severity, 'critical');
    assert.equal(session.adapter.engine !== null, true, 'the engine is alive; this is not onFatal');
  } finally {
    await session.close();
  }
});

test('identical conditions are published once, not once a second', async () => {
  const session = await openWithWarnings({});
  try {
    await session.until((l) => l.some((w) => w.id === 'uncalibrated'));
    const count = session.reports.length;
    await new Promise((r) => setTimeout(r, 2300)); // two more engine status frames
    assert.equal(session.reports.length, count, 'no report while nothing changed');
  } finally {
    await session.close();
  }
});
