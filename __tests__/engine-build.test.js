// The plugin building its own engine.
//
// The decision table in driver/engine-build.js is what a Lab user experiences
// in the first minute after installing: whether the plugin quietly builds,
// asks for a tool by name, or refuses to paper over a setting they typed.
// Every branch is exercised here with the real EngineBuilder and a fake build
// command, so the tests run in milliseconds and never touch cmake.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

import {
  BUILDING_MESSAGE,
  EngineBuilder,
  checkImages,
  checkTools,
  createWatch,
  imagesMessage,
  prerequisitesMessage,
  reconcileEngine,
} from '../driver/engine-build.js';

const node = process.execPath;
const script = (code) => ['-e', code];
const okTools = () => ({ cmake: true, ninja: true, uhd: { version: '4.10', ok: true } });
const noTools = () => ({ cmake: false, ninja: false, uhd: { version: null, ok: false } });
const okImages = () => ({ ok: true, dir: '/images', missing: [] });
const noImages = () => ({ ok: false, dir: '', missing: ['usrp_b200_fw.hex', 'usrp_b205mini_fpga.bin'] });
const tick = (ms = 15) => new Promise((r) => setTimeout(r, ms));
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
  const decided = reconcileEngine({}, report, {
    status: () => ({ ok: true, message: '' }),
    images: okImages,
  });
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

test('missing tools name the install steps for this platform, in order', () => {
  const { seen, report } = reports();
  const builder = new EngineBuilder({ command: node, args: script('process.exit(0)') });
  const watch = createWatch();
  const decided = reconcileEngine({}, report, {
    status: () => ({ ok: false, message: '' }),
    tools: () => ({ cmake: false, ninja: false, uhd: { version: '4.6', ok: false } }),
    builder,
    platform: 'darwin',
    retryMs: 60_000,
    watch,
  });
  assert.equal(decided, 'prerequisites');
  clearTimeout(watch.timer);
  assert.equal(seen[0].status, 'needs-setup', 'not a setting the user got wrong');
  assert.match(seen[0].message, /^Installation incomplete:/, 'the badge says "Bad config"; the text says what it really is');
  assert.match(seen[0].message, /1\) brew install cmake ninja uhd\s+2\) `cd "/, 'numbered steps, in order');
  assert.match(seen[0].message, /installed: 4\.6/, 'says what is there, not just what is wanted');
  assert.match(seen[0].message, /checks again every 15 seconds/, 'says the plugin will look again by itself');
  assert.doesNotMatch(seen[0].message, /change any plugin setting/, 'nothing for the user to poke');
  assert.doesNotMatch(
    seen[0].message,
    /uhd_images_downloader/,
    'Homebrew has no uhd_images_downloader on PATH: the bare command is "command not found"'
  );
  assert.match(
    seen[0].message,
    /install-images\.mjs/,
    'the images still have to be fetched — by the script that travels with the plugin'
  );
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
  const opts = { status, tools: okTools, images: okImages, builder };

  const decided = reconcileEngine({}, report, opts);
  assert.equal(decided, 'building');
  assert.deepEqual(seen[0], { status: 'connecting', message: BUILDING_MESSAGE });

  // a second config push during the build joins it rather than starting another
  const again = reconcileEngine({}, report, opts);
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
  const watch = createWatch();
  reconcileEngine({}, report, {
    status: () => ({ ok: false, message: '' }),
    tools: okTools,
    builder,
    watch,
    retryMs: 60_000,
  });
  await builder.start();
  await new Promise((r) => setImmediate(r));
  assert.equal(seen.at(-1).status, 'bad-config');
  assert.match(seen.at(-1).message, /failed to build/);
  assert.match(seen.at(-1).message, /build-engine/, 'points at the manual build for full output');
  clearTimeout(watch.timer);
});

// The clean-install flow: the status names the terminal steps, the user runs
// them, and the plugin notices by itself — nobody is told to change a setting
// "to make it look again".
test('waiting on the tools, it looks again and builds once they appear', async () => {
  const { seen, report } = reports();
  let built = false;
  let installed = false;
  const builder = new EngineBuilder({
    command: node,
    args: script('setTimeout(() => process.exit(0), 20)'),
  });
  const watch = createWatch();
  const decided = reconcileEngine({}, report, {
    status: () => ({ ok: built, message: '' }),
    tools: () => (installed ? okTools() : noTools()),
    images: okImages,
    builder,
    watch,
    retryMs: 5,
    platform: 'darwin',
  });
  assert.equal(decided, 'prerequisites');
  assert.ok(watch.timer, 'a re-check is pending');

  await tick(20);
  assert.equal(seen.length, 1, 'ticks that find nothing new say nothing new');
  assert.equal(builder.building, false);

  installed = true; // brew finished
  await tick(20);
  assert.equal(builder.building, true, 'the build starts without a config push');
  assert.deepEqual(seen.at(-1), { status: 'connecting', message: BUILDING_MESSAGE });

  built = true;
  await builder.start();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(seen.at(-1), { status: 'ok', message: undefined });
  assert.equal(watch.timer, null, 'nothing left to wait for');
});

test('a built engine with no FPGA images is needs-setup until they are installed', async () => {
  const { seen, report } = reports();
  let images = noImages();
  const watch = createWatch();
  const decided = reconcileEngine({}, report, {
    status: () => ({ ok: true, message: '' }),
    images: () => images,
    mock: () => false,
    watch,
    retryMs: 5,
  });
  assert.equal(decided, 'images');
  assert.equal(seen[0].status, 'needs-setup');
  assert.match(seen[0].message, /^Installation incomplete:/);
  assert.match(seen[0].message, /install-images\.mjs/, 'the one command that fixes it');
  assert.match(seen[0].message, /no radio will be found/, 'says what the consequence is');

  images = { ok: false, dir: '/images', missing: ['usrp_b205mini_fpga.bin'] };
  await tick(20);
  assert.match(seen.at(-1).message, /\/images\) is missing usrp_b205mini_fpga\.bin/, 'names the folder and the file');

  images = okImages();
  await tick(20);
  assert.deepEqual(seen.at(-1), { status: 'ok', message: undefined });
  assert.equal(watch.timer, null);

  // the fake engine programs nothing: mock mode never asks
  const { seen: mocked, report: r2 } = reports();
  reconcileEngine({ mock: true }, r2, {
    status: () => ({ ok: true, message: '' }),
    images: () => {
      throw new Error('must not be asked');
    },
  });
  assert.deepEqual(mocked, [{ status: 'ok', message: undefined }]);
});

test('after a failed build the timer watches for a manual build but never re-runs the compiler', async () => {
  const { seen, report } = reports();
  let built = false;
  let spawned = 0;
  const builder = new EngineBuilder({
    command: node,
    args: script('process.exit(1)'),
    spawnFn: (...a) => {
      spawned++;
      return spawn(...a);
    },
  });
  const watch = createWatch();
  reconcileEngine({}, report, {
    status: () => ({ ok: built, message: '' }),
    tools: okTools,
    images: okImages,
    builder,
    watch,
    retryMs: 5,
  });
  await builder.start();
  await tick(30);
  assert.equal(spawned, 1, 'one compiler, not one every tick');
  assert.equal(seen.at(-1).status, 'bad-config');
  assert.ok(watch.timer, 'still watching for the user’s own build');

  built = true; // node scripts/build-engine.mjs by hand
  await tick(20);
  assert.deepEqual(seen.at(-1), { status: 'ok', message: undefined });
  assert.equal(watch.timer, null);
});

test('checkImages reads uhd_config_info and treats no UHD as nothing to say', () => {
  const dir = '/opt/homebrew/Cellar/uhd/4.10.0.0_2/share/uhd/images';
  const there = new Set([`${dir}/usrp_b200_fw.hex`]);
  const probe = () => `Images directory: ${dir}\n`;
  assert.deepEqual(checkImages({ probe, exists: (p) => there.has(p) }), {
    ok: false,
    dir,
    missing: ['usrp_b205mini_fpga.bin'],
  });
  assert.equal(checkImages({ probe: () => null }).ok, true, 'the tools check owns "no UHD"');
  assert.equal(checkImages({ probe: () => 'Images directory: \n' }).ok, false);
  assert.match(imagesMessage({ ok: false, dir: '', missing: [] }), /no images folder/);
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
