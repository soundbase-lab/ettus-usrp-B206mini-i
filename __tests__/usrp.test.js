// The contract, driven through the real shell over real HTTP.
//
// The radio is the only thing replaced: `SB_USRP_MOCK=1` makes the driver spawn
// driver/fake-engine.js instead of the C++ engine, and everything else — the
// engine process, its Unix socket, its frames, the adapter, the shell — is the
// production path. So these tests fail for the same reasons the plugin would
// fail on a real B206mini, minus the ones that need a radio.
//
// Nothing here hardcodes the plugin's id: it is read from the manifest, so
// `npm run rename` cannot quietly break the suite.

process.env.SB_USRP_MOCK = '1';
process.env.SB_USRP_MOCK_SWEEP_MS = '40';

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { HANDSHAKE_PREFIX } from '@soundbase/plugin-contract';
import { PRODUCT } from '../adapter.js';

const manifest = JSON.parse(
  readFileSync(new URL('../soundbase-plugin.json', import.meta.url), 'utf8')
);

const DEVICE_ID = 'usb:FAKE001';
const DEVICE_PATH = `/devices/${encodeURIComponent(DEVICE_ID)}`;
const START_HZ = 470_000_000;
const STOP_HZ = 608_000_000;
/** The trace is the acquisition grid: 25 kHz cells from 470 to 608 MHz inclusive. */
const STEP_HZ = 25_000;
const POINT_COUNT = (STOP_HZ - START_HZ) / STEP_HZ + 1;
/** The fake engine's scene: a carrier here, and a transient every seventh sweep. */
const CARRIER_HZ = 566_050_000;
const TRANSIENT_HZ = 542_100_000;

const indexOf = (hz) =>
  Math.round(((hz - START_HZ) / (STOP_HZ - START_HZ)) * (POINT_COUNT - 1));

// boots under the real shell, exactly as the host spawns it
const handle = await (await import('../main.js')).default;

const request = async (method, path, body) => {
  const res = await fetch(`${handle.url}${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};

const configure = (patch) =>
  request('POST', `${DEVICE_PATH}/configuration`, {
    startHz: START_HZ,
    stopHz: STOP_HZ,
    ...patch,
  });

test.after(() => handle.close());

test('the manifest is valid and the handshake reports a real port', () => {
  assert.equal(handle.manifest.id, manifest.id);
  assert.ok(handle.port > 0);
  assert.equal(HANDSHAKE_PREFIX, 'SB_PLUGIN_READY ');
});

// The rename trap: an adapter that announces a product the manifest does not
// declare produces a device the host silently ignores, and the only clue is one
// warning line in the plugin log.
test('every product the adapter announces is declared in the manifest', () => {
  const declared = manifest.products.map((p) => p.deviceTypeId);
  assert.ok(
    declared.includes(PRODUCT),
    `adapter.js announces ${PRODUCT}, but soundbase-plugin.json declares only ` +
      `${declared.join(', ')}. Run \`npm run rename <id>\` to change both at once.`
  );
  assert.ok(PRODUCT.startsWith(`plugin:${manifest.id}/`));
});

test('the radio is discovered by serial, not added by hand', async () => {
  const { status, body } = await request('GET', '/devices');
  assert.equal(status, 200);
  const device = body.devices.find((d) => d.id === DEVICE_ID);
  assert.ok(device, JSON.stringify(body.devices));
  assert.equal(device.product, PRODUCT);
  assert.equal(device.discovered, true);
  // the id has to survive a restart: it is in URLs and in the user's project
  assert.match(device.id, /^usb:[A-Za-z0-9]+$/);
});

// A discovered device is not opened until something asks it to do work — an
// idle plugin must not be holding a radio open — so capabilities appear only
// after the first operation on it.
test('open() reports what this radio can do', async () => {
  await configure({});

  const { body } = await request('GET', '/devices');
  const device = body.devices.find((d) => d.id === DEVICE_ID);
  const caps = device.capabilities;
  assert.ok(caps, 'capabilities appear once the device has been opened');
  assert.equal(caps.minFrequencyHz, 70e6);
  assert.equal(caps.maxFrequencyHz, 6e9);
  assert.ok(caps.rbwHz.includes(25_000));
  assert.ok(caps.maxRefLevelDbm > caps.minRefLevelDbm);
  // the shell accumulates all four trace modes in software, so every device
  // advertises them whether or not the hardware has the feature
  assert.deepEqual([...caps.traceModes].sort(), [
    'average',
    'clear-write',
    'max-hold',
    'min-hold',
  ]);
  // the knobs SoundBase has never heard of, declared from what the unit said
  const controls = Object.fromEntries(caps.controls.map((c) => [c.id, c]));
  assert.deepEqual(Object.keys(controls).sort(), [
    'antenna',
    'averaging',
    'detector',
    'dwell',
    'gainDb',
    'gainMode',
    'imageReject',
    'overlay',
    'profile',
    'refLevelDbm',
    'spurMask',
    'window',
  ]);
  assert.equal(controls.overlay.type, 'checkbox');
  assert.equal(controls.overlay.default, false);
  // averaging is offered as a ratio, with string ids because that is what a
  // form's dropdown hands back; it starts where the engine does, RBW ÷ 10
  assert.deepEqual(
    controls.averaging.choices.map((c) => c.id),
    ['1', '3', '10', '30', '100', '300']
  );
  assert.equal(controls.averaging.default, '10');
  assert.ok(controls.dwell.choices.some((c) => c.id === 'long'));
  assert.equal(controls.window.default, 'bh4');
  assert.equal(controls.spurMask.type, 'checkbox');
  assert.equal(controls.spurMask.default, true);
  assert.equal(controls.imageReject.type, 'checkbox');
  assert.equal(controls.imageReject.default, true);
  assert.ok(controls.gainDb.max <= 76);
  // the reference level control offers exactly the range the capabilities do
  assert.equal(controls.refLevelDbm.min, caps.minRefLevelDbm);
  assert.equal(controls.refLevelDbm.max, caps.maxRefLevelDbm);
  assert.equal(controls.refLevelDbm.default, -50);
  // and there is no step limit to offer: the trace is the acquisition grid
  assert.equal(caps.minStepHz, undefined);
  assert.equal(caps.maxStepHz, undefined);
});

// The shell keeps `identity` for the host rather than putting it in /devices,
// so this is the one place it can be checked — and it is worth checking,
// because a coordinator looking at two identical-looking radios in a rack
// picks the right one by the serial the plugin reported.
test('open() identifies the radio it actually opened', async () => {
  const { createSpectrumAnalyzerAdapter } = await import('../adapter.js');
  const adapter = createSpectrumAnalyzerAdapter({ id: DEVICE_ID, config: {} }, {});
  try {
    const { identity } = await adapter.open();
    assert.equal(identity.manufacturer, 'Ettus Research');
    assert.equal(identity.serialNumber, 'FAKE001');
    assert.match(identity.model, /USRP/);
    assert.match(identity.firmware, /fw /);
  } finally {
    await adapter.close();
  }
});

test('the configuration echo reports the grid the engine settled on', async () => {
  const { status, body } = await configure({ rbwHz: 25_000 });
  assert.equal(status, 200);
  assert.equal(body.startHz, START_HZ);
  assert.equal(body.stopHz, STOP_HZ);
  assert.equal(body.pointCount, POINT_COUNT);
  assert.equal(body.rbwHz, 25_000);
  assert.equal(body.stepHz, STEP_HZ);

  // points per sweep is not a setting this radio takes: the cells are the
  // measurement, and the echo says how many there are
  const asked = await configure({ pointCount: 401 });
  assert.equal(asked.body.pointCount, POINT_COUNT);
  const stepped = await configure({ stepHz: 1_000_000 });
  assert.equal(stepped.body.pointCount, POINT_COUNT);
  assert.equal(stepped.body.stepHz, STEP_HZ);
  // a finer RBW means finer cells, and more of them; a coarser one does not
  // make the cells coarser than 25 kHz
  const fine = await configure({ rbwHz: 12_500 });
  assert.equal(fine.body.pointCount, (STOP_HZ - START_HZ) / 12_500 + 1);
  const coarse = await configure({ rbwHz: 100_000 });
  assert.equal(coarse.body.pointCount, POINT_COUNT);
  await configure({ rbwHz: 25_000 });

  // a span that is not on the 25 kHz acquisition grid comes back snapped to it,
  // because that is where the engine really measured
  const snapped = await configure({ startHz: 470_010_000, stopHz: 607_990_000 });
  assert.equal(snapped.status, 200);
  assert.equal(snapped.body.startHz, 470_000_000);
  assert.equal(snapped.body.stopHz, 608_000_000);
});

test('a configuration outside the radio is clamped, not rejected', async () => {
  const { body } = await request('GET', '/devices');
  const caps = body.devices.find((d) => d.id === DEVICE_ID).capabilities;

  const applied = await configure({ startHz: 0, stopHz: caps.maxFrequencyHz * 10 });
  assert.equal(applied.status, 200, 'a request outside the range is still a 200');
  assert.ok(applied.body.startHz >= caps.minFrequencyHz);
  assert.ok(applied.body.stopHz <= caps.maxFrequencyHz);

  const gain = await configure({ controls: { gainMode: 'manual', gainDb: 500 } });
  assert.equal(gain.status, 200);
  assert.ok(gain.body.controls.gainDb <= 76, `gain came back ${gain.body.controls.gainDb}`);
});

test('image rejection is on by default, and the host can turn it off', async () => {
  // The engine itself defaults it off; the plugin's policy has to reach it.
  const first = await configure({ startHz: 470_000_000, stopHz: 608_000_000 });
  assert.equal(first.status, 200);
  assert.equal(first.body.controls.imageReject, true, 'plugin default did not reach the engine');
  const off = await configure({ controls: { imageReject: false } });
  assert.equal(off.body.controls.imageReject, false);
  // and a later patch that says nothing about it leaves it where the host put it
  const later = await configure({ startHz: 500_000_000, stopHz: 540_000_000 });
  assert.equal(later.body.controls.imageReject, false);
  await configure({ controls: { imageReject: true } });
});

test('a patch carrying one control leaves the others in force', async () => {
  await configure({ controls: { dwell: 'hq', antenna: 'RX2', detector: 'rms' } });
  const { body } = await configure({ controls: { detector: 'peak' } });
  assert.equal(body.controls.detector, 'peak');
  assert.equal(body.controls.dwell, 'hq');
  assert.equal(body.controls.antenna, 'RX2');
});

// The reference level is the strongest input the trace should carry. In auto
// gain mode the engine caps the RX gain at −(reference level) — the same method
// as usrp-scanner — so the gain that comes back is the observable effect. (The
// fake engine reports the cap at once; the real one starts at 30 dB and creeps
// up to it over the next sweeps, and its echo is the gain in force right now.)
// Outside the usable range it is clamped, and the clamped value is the echo.
test('the reference level sets auto gain, and is clamped to what gain can do', async () => {
  // the contract's own field, as a host that renders one would send it (the
  // shell resends every control it has seen, so gain has to be put back to
  // auto after the clamping test above left it manual)
  const field = await configure({ refLevelDbm: -40, controls: { gainMode: 'auto' } });
  assert.equal(field.status, 200);
  assert.equal(field.body.controls.refLevelDbm, -40);
  assert.equal(field.body.controls.gainDb, 40);

  // the control, as SoundBase's plugin-device form sends it
  const control = await configure({ controls: { gainMode: 'auto', refLevelDbm: -30 } });
  assert.equal(control.body.controls.refLevelDbm, -30);
  assert.equal(control.body.controls.gainDb, 30);

  const low = await configure({ controls: { refLevelDbm: -90 } });
  assert.equal(low.body.controls.refLevelDbm, -60, 'more gain than the radio has: the cap');
  assert.equal(low.body.controls.gainDb, 60);

  const high = await configure({ controls: { refLevelDbm: 10 } });
  assert.equal(high.body.controls.refLevelDbm, 0, 'negative gain does not exist');
  assert.equal(high.body.controls.gainDb, 0);

  // a patch that says nothing about it leaves it in force
  const other = await configure({ controls: { detector: 'rms' } });
  assert.equal(other.body.controls.refLevelDbm, 0);
  assert.equal(other.body.controls.gainDb, 0);

  // manual gain is the user's number, whatever the reference level says
  const manual = await configure({ controls: { gainMode: 'manual', gainDb: 20 } });
  assert.equal(manual.body.controls.gainDb, 20);
  assert.equal(manual.body.controls.refLevelDbm, 0);

  await configure({ controls: { gainMode: 'auto', refLevelDbm: -50 } });
});

test('the control wins over the field when one patch carries both', async () => {
  const { createSpectrumAnalyzerAdapter } = await import('../adapter.js');
  const adapter = createSpectrumAnalyzerAdapter({ id: DEVICE_ID, config: {} }, {});
  try {
    await adapter.open();
    const both = await adapter.applyConfig({
      refLevelDbm: -20,
      controls: { refLevelDbm: -35 },
    });
    assert.equal(both.refLevelDbm, -35);
    assert.equal(both.controls.refLevelDbm, -35);
    assert.equal(both.controls.gainDb, 35);
    // the echo is the engine's, not the request: a level between integers
    // still maps onto an integer gain
    const fraction = await adapter.applyConfig({ controls: { refLevelDbm: -42.4 } });
    assert.equal(fraction.controls.refLevelDbm, -42.4);
    assert.equal(fraction.controls.gainDb, 42);
  } finally {
    await adapter.close();
  }
});

// Averaging is a ratio on the form and a video bandwidth in the engine, so the
// echo has to come back through the engine's own clamp: `resolved.vbwHz` is
// the bandwidth in force, and the control is the choice that bandwidth is.
test('averaging is a ratio of the RBW, clamped to its choices', async () => {
  const thirty = await configure({ rbwHz: 25_000, controls: { averaging: '30' } });
  assert.equal(thirty.status, 200);
  assert.equal(thirty.body.controls.averaging, '30');
  assert.ok(Math.abs(thirty.body.resolved.vbwHz - 25_000 / 30) < 1);

  // the ratio is what the user set, so it is what survives a new RBW
  const wide = await configure({ rbwHz: 100_000 });
  assert.equal(wide.body.controls.averaging, '30');
  assert.ok(Math.abs(wide.body.resolved.vbwHz - 100_000 / 30) < 1);

  // outside the choices is snapped to one, never refused; a number is as good
  // as its string
  const high = await configure({ controls: { averaging: 5000 } });
  assert.equal(high.status, 200);
  assert.equal(high.body.controls.averaging, '300');
  const low = await configure({ controls: { averaging: 0 } });
  assert.equal(low.body.controls.averaging, '1');
  assert.equal(low.body.resolved.vbwHz, 100_000, 'no averaging is VBW = RBW');
  const between = await configure({ controls: { averaging: 40 } });
  assert.equal(between.body.controls.averaging, '30');
  // and something that is not a number at all leaves it where it was
  const junk = await configure({ controls: { averaging: 'lots' } });
  assert.equal(junk.status, 200);
  assert.equal(junk.body.controls.averaging, '30');

  await configure({ rbwHz: 25_000, controls: { averaging: '10' } });
});

test('dwell, averaging, window and spur masking each leave the others in force', async () => {
  const { createSpectrumAnalyzerAdapter } = await import('../adapter.js');
  const adapter = createSpectrumAnalyzerAdapter({ id: DEVICE_ID, config: {} }, {});
  const knobs = ({ controls }) => ({
    dwell: controls.dwell,
    averaging: controls.averaging,
    window: controls.window,
    spurMask: controls.spurMask,
  });
  try {
    await adapter.open();
    const defaults = await adapter.applyConfig({});
    assert.deepEqual(knobs(defaults), {
      dwell: 'coordination',
      averaging: '10',
      window: 'bh4',
      spurMask: true,
    });

    const set = { dwell: 'long', averaging: '100', window: 'hann', spurMask: false };
    assert.deepEqual(knobs(await adapter.applyConfig({ controls: set })), set);
    // a patch carrying one control, and one carrying none
    const one = await adapter.applyConfig({ controls: { detector: 'peak' } });
    assert.equal(one.controls.detector, 'peak');
    assert.deepEqual(knobs(one), set);
    assert.deepEqual(knobs(await adapter.applyConfig({ startHz: 500e6, stopHz: 540e6 })), set);
    for (const [id, value] of [
      ['dwell', 'fast'],
      ['averaging', '3'],
      ['window', 'bh4'],
      ['spurMask', true],
    ]) {
      set[id] = value;
      assert.deepEqual(knobs(await adapter.applyConfig({ controls: { [id]: value } })), set);
    }
    // a value that is not one of the choices is not a change
    const junk = await adapter.applyConfig({
      controls: { dwell: 'forever', window: 'kaiser', spurMask: 'no', averaging: null },
    });
    assert.deepEqual(knobs(junk), set);

    // An RBW change on its own carries the ratio with it: the engine holds a
    // bandwidth in hertz, and left alone that would turn 3× into 6×.
    const rbw = await adapter.applyConfig({ rbwHz: 50_000 });
    assert.equal(rbw.controls.averaging, '3');
    assert.ok(Math.abs(rbw.resolved.vbwHz - 50_000 / 3) < 1);

    // The contract's own `vbwHz` is honoured when the control is not in the
    // patch, shows up on the control, and loses to it when both arrive.
    const field = await adapter.applyConfig({ vbwHz: 5_000 });
    assert.equal(field.controls.averaging, '10');
    const both = await adapter.applyConfig({ vbwHz: 50_000, controls: { averaging: '300' } });
    assert.equal(both.controls.averaging, '300');
    // a video bandwidth wider than the RBW is the engine's to clamp
    const over = await adapter.applyConfig({ vbwHz: 200_000 });
    assert.equal(over.controls.averaging, '1');
  } finally {
    await adapter.close();
  }
});

// The engine sends the averaged trace and the detector's own in every frame.
// With the overlay on, the one that is not the primary trace goes to the shell
// as a named series — `onTrace`'s second argument, which a shell that predates
// series ignores, so this is checked at the adapter rather than over HTTP.
test('the overlay reports the frame’s other curve as a named series', async () => {
  const { createSpectrumAnalyzerAdapter } = await import('../adapter.js');
  const adapter = createSpectrumAnalyzerAdapter({ id: DEVICE_ID, config: {} }, {});
  const sweeps = [];
  const nextSweep = async () => {
    sweeps.length = 0;
    const deadline = Date.now() + 5000;
    while (sweeps.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(sweeps.length > 0, 'no sweep arrived');
    return sweeps.at(-1);
  };
  const mean = (values) => values.reduce((a, b) => a + b, 0) / values.length;
  try {
    await adapter.open();
    const off = await adapter.applyConfig({ startHz: START_HZ, stopHz: STOP_HZ });
    assert.equal(off.controls.overlay, false);
    await adapter.startSweep((...args) => sweeps.push(args));
    assert.equal((await nextSweep()).length, 1, 'off: the trace and nothing else');

    const on = await adapter.applyConfig({ controls: { overlay: true } });
    assert.equal(on.controls.overlay, true);
    const [rms, series] = await nextSweep();
    assert.equal(series.length, 1);
    assert.equal(series[0].name, 'Peak');
    assert.equal(series[0].amplitudesDbm.length, rms.length);
    assert.equal(rms.length, POINT_COUNT);
    assert.ok(mean(series[0].amplitudesDbm) > mean(rms), 'peak sits above the average');

    // under any other detector the primary is that detector and the series is RMS
    const peak = await adapter.applyConfig({ controls: { detector: 'peak' } });
    assert.equal(peak.controls.overlay, true, 'another control leaves it in force');
    const [primary, under] = await nextSweep();
    assert.equal(under[0].name, 'RMS');
    assert.ok(mean(under[0].amplitudesDbm) < mean(primary));

    // not a boolean is not a change
    assert.equal((await adapter.applyConfig({ controls: { overlay: 'yes' } })).controls.overlay, true);
    await adapter.applyConfig({ controls: { overlay: false } });
    assert.equal((await nextSweep()).length, 1);
  } finally {
    await adapter.stopSweep();
    await adapter.close();
  }
});

// Long dwell and heavy averaging make sweeps the host would otherwise take
// for a stall. Ordinary sweeps say nothing and the host learns their rate.
test('a sweep slow enough to look like a stall says how long it takes', async () => {
  const quick = await configure({ controls: { dwell: 'coordination' } });
  assert.equal(quick.body.resolved?.sweepTimeMs, undefined);

  const slow = await configure({
    startHz: 70_000_000,
    stopHz: 6_000_000_000,
    controls: { dwell: 'long' },
  });
  assert.equal(slow.status, 200);
  assert.equal(slow.body.controls.dwell, 'long');
  assert.ok(slow.body.resolved.sweepTimeMs > 2000, `said ${slow.body.resolved.sweepTimeMs} ms`);

  await configure({ controls: { dwell: 'coordination' } });
});

test('sweeping produces a spectrum on the acquisition grid', async (t) => {
  await configure({ rbwHz: 25_000 });
  const started = await request('POST', `${DEVICE_PATH}/sweep/start`);
  assert.equal(started.status, 200);
  assert.equal(started.body.sweeping, true);
  t.after(() => request('POST', `${DEVICE_PATH}/sweep/stop`));

  const { status, body } = await request('GET', `${DEVICE_PATH}/trace`);
  assert.equal(status, 200);
  assert.equal(body.unit, 'dBm');
  assert.equal(body.pointCount, POINT_COUNT);
  assert.equal(body.amplitudesDbm.length, POINT_COUNT);
  assert.equal(body.startHz, START_HZ);
  assert.equal(body.stopHz, STOP_HZ);
  assert.ok(body.sweepId >= 1);

  const amps = body.amplitudesDbm;
  // no holes reach the plot: masked spurs and LO gaps are filled, never drawn
  assert.ok(amps.every(Number.isFinite), 'a non-finite amplitude reached the trace');

  const floor = amps.slice(indexOf(600e6), indexOf(607e6));
  const floorMean = floor.reduce((a, b) => a + b, 0) / floor.length;
  assert.ok(floorMean < -95, `noise floor sat at ${floorMean} dBm`);

  const carrier = Math.max(...amps.slice(indexOf(CARRIER_HZ) - 1, indexOf(CARRIER_HZ) + 2));
  assert.ok(carrier > floorMean + 30, `carrier only reached ${carrier} dBm`);
});

test('successive polls see successive sweeps', async (t) => {
  await configure({});
  await request('POST', `${DEVICE_PATH}/sweep/start`);
  t.after(() => request('POST', `${DEVICE_PATH}/sweep/stop`));

  const first = await request('GET', `${DEVICE_PATH}/trace`);
  const startedAt = Date.now();
  const second = await request('GET', `${DEVICE_PATH}/trace`);
  const elapsed = Date.now() - startedAt;

  assert.ok(second.body.sweepId > first.body.sweepId);
  // the long poll returns on the next sweep, not after the hold cap
  assert.ok(elapsed < 2000, `waited ${elapsed}ms for the next sweep`);
});

// The reason the engine free-runs and the plugin reports every completed sweep:
// a transmitter that keys up for one sweep has to end up in the hold whether or
// not SoundBase happened to poll during it.
test('max-hold catches a transient nobody polled for', async (t) => {
  await configure({ traceMode: 'max-hold' });
  await request('POST', `${DEVICE_PATH}/sweep/start`);
  t.after(() => request('POST', `${DEVICE_PATH}/sweep/stop`));

  let trace = await request('GET', `${DEVICE_PATH}/trace`);
  const target = trace.body.sweepId + 10;
  const deadline = Date.now() + 10_000;
  while (trace.body.sweepId < target && Date.now() < deadline) {
    trace = await request('GET', `${DEVICE_PATH}/trace`);
  }
  assert.ok(trace.body.sweepId >= target, `only reached sweep ${trace.body.sweepId}`);

  const at = indexOf(TRANSIENT_HZ);
  const held = Math.max(...trace.body.amplitudesDbm.slice(at - 1, at + 2));
  assert.ok(held > -70, `the transient never accumulated (peak ${held} dBm)`);
});

// 576 MHz is 18 × 32 MHz in the fake's scene, with nothing else near it. The
// engine fills that cell from its neighbours unless told not to, which hides
// the spur and anything else sitting exactly there.
test('internal spurs are masked unless the host asks to see them', async (t) => {
  const SPUR_HZ = 576_000_000;
  const settings = { rbwHz: 25_000, traceMode: 'clear-write' };
  await configure({ ...settings, controls: { spurMask: true } });
  await request('POST', `${DEVICE_PATH}/sweep/start`);
  t.after(async () => {
    await request('POST', `${DEVICE_PATH}/sweep/stop`);
    await configure({ controls: { spurMask: true } });
  });

  // Two polls: whatever the shell was holding, then the sweep after it —
  // which can only have been made under the configuration just applied.
  const levelNow = async () => {
    const held = await request('GET', `${DEVICE_PATH}/trace`);
    const { body } = await request(
      'GET',
      `${DEVICE_PATH}/trace?sinceSweepId=${held.body.sweepId}`
    );
    return body.amplitudesDbm[indexOf(SPUR_HZ)];
  };

  const masked = await levelNow();
  assert.ok(masked < -95, `the masked cell read ${masked} dBm`);

  const off = await configure({ ...settings, controls: { spurMask: false } });
  assert.equal(off.body.controls.spurMask, false);
  const shown = await levelNow();
  assert.ok(shown > -90, `the spur did not appear with masking off (${shown} dBm)`);
});

test('the device closes cleanly and is discovered again', async () => {
  const removed = await request('DELETE', DEVICE_PATH);
  assert.ok([200, 204].includes(removed.status), `DELETE returned ${removed.status}`);

  // Discovery finds it again, and it opens again — which it could not do if the
  // engine process the first adapter spawned were still holding the radio.
  const deadline = Date.now() + 15_000;
  let listed = false;
  while (!listed && Date.now() < deadline) {
    const { body } = await request('GET', '/devices');
    listed = body.devices.some((d) => d.id === DEVICE_ID);
    if (!listed) await new Promise((r) => setTimeout(r, 250));
  }
  assert.ok(listed, 'the radio never came back into the device list');

  const reopened = await configure({});
  assert.equal(reopened.status, 200);
  assert.equal(reopened.body.pointCount, POINT_COUNT);
});

// Core 1.1: the radio's conditions ride on the device status as `warnings`,
// without changing the status. The fake radio is uncalibrated, which is an
// `info` — worth knowing, the trace is fine — so that is what a healthy mock
// reports, and the only thing it reports.
test('the radio’s conditions reach the host as warnings on an ok status', async () => {
  await configure({});
  const deadline = Date.now() + 5_000;
  let device;
  for (;;) {
    ({ body: { devices: [device] } } = await request('GET', '/devices'));
    if (device?.status?.warnings?.length || Date.now() > deadline) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(device.status.status, 'ok', 'a warning is not a failure');
  assert.deepEqual(
    device.status.warnings.map((w) => [w.id, w.severity]),
    [['uncalibrated', 'info']]
  );
  assert.match(device.status.warnings[0].message, /Relative readings/);
});
