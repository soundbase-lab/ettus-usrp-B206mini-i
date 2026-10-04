// An engine that connects and then never reports a device.
//
// This is what a user sees when the radio stops answering on USB — a wedged
// controller, a hub, a USB 2 port slowing the FPGA load past the timeout. The
// message is the whole product here: it has to say what UHD was doing, what to
// do about it, and how to watch the same open outside SoundBase.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { EngineClient, answers, startupTimeoutMessage } from '../driver/engine-client.js';
import { FAKE_ENGINE } from '../driver/locate.js';

const args = { timeoutMs: 90_000, deviceArgs: 'type=b200,serial=365C108' };

test('no UHD output at all: the radio is not answering, replug it', () => {
  const m = startupTimeoutMessage({ ...args, lines: ['[engine I 0.000] connected to /tmp/x.sock'] });
  assert.match(m, /within 90s/);
  assert.match(m, /UHD printed nothing at all/);
  assert.match(m, /Unplug it/);
  assert.match(m, /uhd_usrp_probe --args "type=b200,serial=365C108"/, 'the probe names the radio');
  assert.match(m, /Engine said: \[engine I 0\.000\] connected/, 'the engine tail still travels');
});

test('stuck loading the FPGA image: name the stage and the slow-link suspects', () => {
  const m = startupTimeoutMessage({
    ...args,
    lines: [
      '[engine I 0.000] connected to /tmp/x.sock',
      '[INFO] [UHD] Mac OS; Clang version 21.0.0; Boost_109200; UHD_4.10.0.0',
      '[INFO] [B200] Detected Device: B206mini',
      '[INFO] [B200] Loading FPGA image: /opt/homebrew/share/uhd/images/usrp_b205mini_fpga.bin...',
    ],
  });
  assert.match(m, /still loading the radio's FPGA image/);
  assert.match(m, /USB 3 port on the computer itself/);
  assert.doesNotMatch(m, /printed nothing/);
});

test('a USB 2 link is called out when UHD reported one', () => {
  const m = startupTimeoutMessage({
    ...args,
    lines: [
      '[INFO] [B200] Detected Device: B206mini',
      '[INFO] [B200] Operating over USB 2.',
      '[INFO] [B200] Initialize CODEC control...',
    ],
  });
  assert.match(m, /UHD got as far as "\[B200\] Initialize CODEC control\.\.\."/);
  assert.match(m, /on a USB 2 link/);
});

test('without a serial the probe command still works, for a hand-added device', () => {
  const m = startupTimeoutMessage({ timeoutMs: 90_000, lines: [], deviceArgs: 'type=b200' });
  assert.match(m, /uhd_usrp_probe --args "type=b200"\./);
});

test('a real engine that connects and goes quiet is killed and reported with its UHD tail', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'sb-silent-'));
  const script = path.join(dir, 'silent-engine.js');
  // Same command line as the C++ engine: connect to --socket, say what UHD
  // would say, then hang the way a blocked multi_usrp::make does.
  writeFileSync(
    script,
    `import net from 'node:net';
     const sock = process.argv[process.argv.indexOf('--socket') + 1];
     const c = net.connect(sock, () => {
       process.stderr.write('[engine I 0.000] connected to ' + sock + '\\n');
       process.stderr.write('[INFO] [B200] Detected Device: B206mini\\n');
       process.stderr.write('[INFO] [B200] Loading FPGA image: /x/usrp_b205mini_fpga.bin...\\n');
     });
     c.on('error', () => {});
     setTimeout(() => {}, 60_000);`
  );
  writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
  const engine = new EngineClient({
    binPath: script,
    deviceArgs: 'type=b200,serial=TEST01',
    tag: 'silent',
    startupTimeoutMs: 700,
  });
  await assert.rejects(engine.start(), (err) => {
    assert.equal(err.name, 'EngineError');
    assert.match(err.message, /did not report a device within 1s/);
    assert.match(err.message, /still loading the radio's FPGA image/);
    assert.match(err.message, /serial=TEST01/);
    return true;
  });
  assert.equal(engine.running, false, 'the silent engine must not be left holding the radio');
});

// At startup the engine announces its default plan twice — once on its own,
// once for the plan its command line carried — each with an `applied` nobody
// asked for. The first status sits between the two, so a plan sent as soon as
// the engine is ready can be overtaken by the second announcement. Matching
// replies to plans by order alone, the plugin took that announcement as its
// answer: it echoed the default span, expected sweeps on that grid, and
// dropped every sweep the engine really sent. On a real radio that was a
// device that starts and never draws a trace, about one start in two.
test('the first plan is answered by its own reply, not by a plan the engine announces at startup', async () => {
  const engine = new EngineClient({
    binPath: FAKE_ENGINE,
    deviceArgs: 'type=b200,serial=TEST02',
    tag: 'startup',
  });
  try {
    await engine.start();
    const reply = await engine.setPlan({ startHz: 470e6, stopHz: 616e6 });
    assert.equal(reply.applied.stopHz, 616e6, 'the echo is the reply to this plan');
    assert.equal(reply.applied.binCount, 5841);
    // and the next one is not answered by the reply before it
    const next = await engine.setPlan({ stopHz: 600e6 });
    assert.equal(next.applied.stopHz, 600e6);
  } finally {
    await engine.stop();
  }
});

test('a reply answers a plan only when it echoes what the plan set', () => {
  const announced = { type: 'applied', requested: { startHz: 470e6, stopHz: 608e6, imageReject: false, dwell: 'coordination' } };
  assert.equal(answers(announced, { startHz: 470e6, stopHz: 616e6 }), false, 'a different span');
  assert.equal(answers(announced, { imageReject: true }), false, 'a different switch');
  assert.equal(answers(announced, { dwell: 'fast' }), false, 'a different choice');
  assert.equal(answers(announced, { startHz: 470e6, stopHz: 608e6 }), true, 'the same values are an answer');
  assert.equal(answers(announced, {}), true, 'an empty patch asks only for the plan in force');
  assert.equal(answers(announced, { somethingNew: 1 }), true, 'a field the engine does not report cannot be judged');
  assert.equal(answers({ type: 'applied' }, { stopHz: 616e6 }), true, 'nor can a reply with no echo at all');
});
