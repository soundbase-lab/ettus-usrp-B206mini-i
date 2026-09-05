// The plugin building its own engine.
//
// The decision table in driver/engine-build.js is what a Lab user experiences
// in the first minute after installing: whether the plugin quietly builds,
// asks for a tool by name, or refuses to paper over a setting they typed.
// Every branch is exercised here with the real EngineBuilder and a fake build
// command, so the tests run in milliseconds and never touch cmake.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BUILDING_MESSAGE,
  EngineBuilder,
  checkTools,
  prerequisitesMessage,
  reconcileEngine,
} from '../driver/engine-build.js';

const node = process.execPath;
const script = (code) => ['-e', code];
const okTools = () => ({ cmake: true, ninja: true, uhd: { version: '4.10', ok: true } });
const reports = () => {
  const seen = [];
  return { seen, report: (status, message) => seen.push({ status, message }) };
};

test('one build at a time, and every caller gets the same one', async () => {
  const builder = new EngineBuilder({
    command: node,
    args: script('setTimeout(() => process.exit(0), 50)'),
  });
  assert.equal(builder.building, false);
  let done = 0;
  const first = builder.start(() => done++);
  const second = builder.start(() => done++);
  assert.equal(builder.building, true);
  assert.equal(first, second, 'a second request must join the running build');
  const result = await first;
  assert.equal(result.ok, true);
  assert.equal(done, 1, 'onDone fires once per build, not once per caller');
  assert.equal(builder.building, false);
});

test('a failed build keeps the compiler’s last lines', async () => {
  const builder = new EngineBuilder({
    command: node,
    args: script('console.error("engine.cpp:12: error: no such thing"); process.exit(2)'),
  });
  const result = await builder.start();
  assert.equal(result.ok, false);
  assert.equal(result.code, 2);
  assert.ok(result.tail.some((l) => /no such thing/.test(l)), JSON.stringify(result.tail));
});

test('an engine that exists is simply ok', () => {
  const { seen, report } = reports();
  const decided = reconcileEngine({}, report, { status: () => ({ ok: true, message: '' }) });
  assert.equal(decided, 'ok');
  assert.deepEqual(seen, [{ status: 'ok', message: undefined }]);
});

test('a configured path that is missing is the user’s to fix, not built over', () => {
  const { seen, report } = reports();
  const builder = new EngineBuilder({ command: node, args: script('process.exit(0)') });
  const decided = reconcileEngine(
    { enginePath: '/nonexistent/engine' },
    report,
    { status: () => ({ ok: false, message: 'no such file' }), tools: okTools, builder }
  );
  assert.equal(decided, 'bad-config');
  assert.equal(seen[0].status, 'bad-config');
  assert.equal(builder.building, false, 'nothing must be spawned');
});

test('missing tools name the install command for this platform', () => {
  const { seen, report } = reports();
  const builder = new EngineBuilder({ command: node, args: script('process.exit(0)') });
  const decided = reconcileEngine({}, report, {
    status: () => ({ ok: false, message: '' }),
    tools: () => ({ cmake: false, ninja: false, uhd: { version: '4.6', ok: false } }),
    builder,
    platform: 'darwin',
  });
  assert.equal(decided, 'prerequisites');
  assert.equal(seen[0].status, 'bad-config');
  assert.match(seen[0].message, /brew install cmake ninja uhd/);
  assert.match(seen[0].message, /installed: 4\.6/, 'says what is there, not just what is wanted');
  assert.equal(builder.building, false);

  assert.match(
    prerequisitesMessage({ cmake: true, ninja: true, uhd: { version: null, ok: false } }, 'linux'),
    /apt install/
  );
});

test('with the tools present it builds, reports progress, and ends ok', async () => {
  const { seen, report } = reports();
  let built = false;
  const builder = new EngineBuilder({
    command: node,
    args: script('setTimeout(() => process.exit(0), 30)'),
  });
  const status = () => ({ ok: built, message: 'not yet' });

  const decided = reconcileEngine({}, report, { status, tools: okTools, builder });
  assert.equal(decided, 'building');
  assert.deepEqual(seen[0], { status: 'connecting', message: BUILDING_MESSAGE });

  // a second config push during the build joins it rather than starting another
  const again = reconcileEngine({}, report, { status, tools: okTools, builder });
  assert.equal(again, 'building');
  assert.equal(seen.length, 2);

  built = true; // what the build script leaves behind
  await builder.start();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(seen.at(-1), { status: 'ok', message: undefined });
});

test('a build that exits 0 but leaves no binary is still a failure', async () => {
  const { seen, report } = reports();
  const builder = new EngineBuilder({ command: node, args: script('process.exit(0)') });
  reconcileEngine({}, report, {
    status: () => ({ ok: false, message: '' }),
    tools: okTools,
    builder,
  });
  await builder.start();
  await new Promise((r) => setImmediate(r));
  assert.equal(seen.at(-1).status, 'bad-config');
  assert.match(seen.at(-1).message, /failed to build/);
  assert.match(seen.at(-1).message, /build-engine/, 'points at the manual build for full output');
});

test('checkTools reads real version strings and applies the UHD floor', () => {
  const probe = (cmd) =>
    ({ cmake: 'cmake version 4.4.3', ninja: '1.13.2', uhd_config_info: 'UHD 4.10.0.0' })[cmd] ?? null;
  const t = checkTools({ probe });
  assert.deepEqual(t, { cmake: true, ninja: true, uhd: { version: '4.10', ok: true } });
  const old = checkTools({ probe: (cmd) => (cmd === 'uhd_config_info' ? 'UHD 4.6.0.0' : null) });
  assert.equal(old.uhd.ok, false);
  assert.equal(old.cmake, false);
});
