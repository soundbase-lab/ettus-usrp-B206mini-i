// What happens when the radio goes away.
//
// This is the failure the whole architecture is arranged around. libuhd owns a
// USB device and can block in a call that never returns; if that happened
// inside the plugin process, SoundBase would see the health check stop, kill
// the plugin and restart it, and every other device this plugin serves would go
// with it. Because the engine is a separate process, its death is one device's
// problem — reported through `onFatal`, recovered on the next operation.
//
// The fake engine exits on command here, which is as close to a yanked USB
// cable as a test can get without a person and a cable.

process.env.SB_USRP_MOCK = '1';
process.env.SB_USRP_MOCK_SWEEP_MS = '40';
process.env.SB_USRP_MOCK_DIE_AFTER_MS = '1200';

import test from 'node:test';
import assert from 'node:assert/strict';

const DEVICE_ID = 'usb:FAKE001';
const DEVICE_PATH = `/devices/${encodeURIComponent(DEVICE_ID)}`;

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

/** The shell only enumerates while a device window is open; GET /devices opens one. */
const waitForDevice = async (timeoutMs = 15_000) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { body } = await request('GET', '/devices');
    if (body.devices.some((d) => d.id === DEVICE_ID)) return;
    if (Date.now() > deadline) throw new Error('the mock radio was never discovered');
    await new Promise((r) => setTimeout(r, 100));
  }
};

const statusOf = async () => {
  const { body } = await request('GET', '/devices');
  return body.devices.find((d) => d.id === DEVICE_ID)?.status;
};

test.after(() => handle.close());

test('an engine that dies fails its device and leaves the plugin alive', async () => {
  await waitForDevice();
  const configured = await request('POST', `${DEVICE_PATH}/configuration`, {
    startHz: 470e6,
    stopHz: 608e6,
    pointCount: 401,
  });
  assert.equal(configured.status, 200);
  await request('POST', `${DEVICE_PATH}/sweep/start`);

  const deadline = Date.now() + 15_000;
  let status = await statusOf();
  while (status?.status !== 'failed' && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
    status = await statusOf();
  }
  assert.equal(status?.status, 'failed', `device status was ${JSON.stringify(status)}`);
  // the message is what a coordinator reads an hour before doors, so it has to
  // say what happened rather than "Error"
  assert.match(status.message, /engine/i);

  // the plugin itself is still serving: this is the whole point of the split
  const info = await request('GET', '/info');
  assert.equal(info.status, 200);
  assert.equal(info.body.id, 'ettus-usrp-b206mini-i');
});

test('the device recovers on the next operation once the radio is back', async () => {
  delete process.env.SB_USRP_MOCK_DIE_AFTER_MS;
  await waitForDevice();

  const reopened = await request('POST', `${DEVICE_PATH}/configuration`, {
    startHz: 470e6,
    stopHz: 608e6,
    pointCount: 401,
  });
  assert.equal(reopened.status, 200);
  assert.equal(reopened.body.pointCount, 401);

  await request('POST', `${DEVICE_PATH}/sweep/start`);
  const trace = await request('GET', `${DEVICE_PATH}/trace`);
  assert.equal(trace.status, 200);
  assert.equal(trace.body.amplitudesDbm.length, 401);
  await request('POST', `${DEVICE_PATH}/sweep/stop`);
});

// The other way a plugin appears broken for no visible reason: it installed
// fine, but the engine was never compiled. That has to say so in the device's
// status message, where the user will actually see it.
test('a missing engine binary is a message that says what to do', async (t) => {
  const { createSpectrumAnalyzerAdapter } = await import('../adapter.js');
  // mock mode would satisfy the search, so ask for the real resolution path
  delete process.env.SB_USRP_MOCK;
  t.after(() => {
    process.env.SB_USRP_MOCK = '1';
  });

  const adapter = createSpectrumAnalyzerAdapter(
    { id: DEVICE_ID, config: {} },
    { enginePath: '/nonexistent/engine' }
  );
  try {
    await assert.rejects(() => adapter.open(), /npm run build:engine/);
  } finally {
    await adapter.close();
  }
});
