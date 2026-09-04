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
const POINT_COUNT = 401;
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
    pointCount: POINT_COUNT,
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
    'detector',
    'dwell',
    'gainDb',
    'gainMode',
    'profile',
  ]);
  assert.ok(controls.gainDb.max <= 76);
});

// The shell keeps `identity` for the host rather than putting it in /devices,
// so this is the one place it can be checked — and it is worth checking,
// because a coordinator looking at two identical-looking radios in a rack
// picks the right one by the serial the plugin reported.
test('open() identifies the radio it actually opened', async () => {
  const { createSpectrumAnalyzerAdapter } = await import('../adapter.js');
  const adapter = createSpectrumAnalyzerAdapter({ id: DEVICE_ID, config: {} }, { mock: true });
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
  assert.equal(body.stepHz, (STOP_HZ - START_HZ) / (POINT_COUNT - 1));

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

test('a patch carrying one control leaves the others in force', async () => {
  await configure({ controls: { dwell: 'hq', antenna: 'RX2', detector: 'rms' } });
  const { body } = await configure({ controls: { detector: 'peak' } });
  assert.equal(body.controls.detector, 'peak');
  assert.equal(body.controls.dwell, 'hq');
  assert.equal(body.controls.antenna, 'RX2');
});

test('sweeping produces a spectrum on the requested points', async (t) => {
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
