// Discovery while a radio is in use.
//
// These run against the adapter directly rather than through the shell,
// because the thing under test is what `discoverDevices` reports at moments
// when no device entry exists yet — which is precisely what the shell would be
// reacting to.

process.env.SB_USRP_MOCK = '1';
process.env.SB_USRP_MOCK_SWEEP_MS = '40';

import test from 'node:test';
import assert from 'node:assert/strict';

const DEVICE_ID = 'usb:FAKE001';

// A radio that is in use stops answering enumeration: `engine --find` returns
// nothing while an engine has the device open. The adapter therefore keeps its
// own list of radios it has claimed, and claims one *before* spawning the
// engine — because between the spawn and the engine's first status the device
// has no adapter yet, and the shell removes a discovered device that discovery
// stops reporting and that nothing has open. Getting that window wrong makes a
// device vanish seconds after it started working, and every later request 404.
test('a radio being opened stays in the device list while it is unenumerable', async (t) => {
  const { discoverDevices, createSpectrumAnalyzerAdapter } = await import('../adapter.js');
  process.env.SB_USRP_MOCK_FIND_EMPTY = '1';
  t.after(() => {
    delete process.env.SB_USRP_MOCK_FIND_EMPTY;
  });

  // enumeration sees nothing, and nothing is claimed yet
  assert.deepEqual(await discoverDevices({}), []);

  const adapter = createSpectrumAnalyzerAdapter({ id: DEVICE_ID, config: {} }, { mock: true });
  let opening;
  try {
    opening = adapter.open();
    // mid-open: the engine may already have the radio, and the shell has no
    // adapter recorded — this is the window the device used to disappear in
    const during = await discoverDevices({});
    assert.deepEqual(
      during.map((d) => d.id),
      [DEVICE_ID],
      'the radio was dropped from discovery while it was being opened'
    );

    await opening;
    const after = await discoverDevices({});
    assert.deepEqual(after.map((d) => d.id), [DEVICE_ID]);
  } finally {
    // Let the open settle before closing, so a failed assertion above tears the
    // engine down instead of leaving one running and hanging the whole run.
    await opening?.catch(() => {});
    await adapter.close();
  }

  // released: with enumeration still empty, it is genuinely gone
  assert.deepEqual(await discoverDevices({}), []);
});

// The other half of that window: a device added and removed before the engine
// has finished coming up. Closing has to stop an engine that is still starting,
// or it keeps the radio for the life of the plugin — invisibly, because nothing
// holds a reference to it any more.
test('closing while the engine is still starting leaves nothing running', async () => {
  const { createSpectrumAnalyzerAdapter } = await import('../adapter.js');
  const adapter = createSpectrumAnalyzerAdapter({ id: DEVICE_ID, config: {} }, { mock: true });

  const opening = adapter.open();
  await adapter.close();

  await assert.rejects(
    () => opening,
    /shut down|not running/,
    'open() resolved after close(), so something is still running'
  );
  assert.equal(adapter.engine, null);
});
