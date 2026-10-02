// The platform declaration, and the four things that read it.
//
// This plugin does not run on Windows — the engine needs Unix domain sockets
// and flock(2). That fact is declared once, as `os` in package.json, and npm,
// CI, `npm run doctor` and the adapter all read it from there. These tests
// exist because that is a mechanism with four consumers and one source: the
// failure it prevents is a CI matrix that has quietly gone back to running a
// platform the plugin cannot support, which looks like a broken plugin rather
// than a misconfigured workflow.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { PLUGIN_PLATFORMS } from '@soundbase/plugin-contract';

import {
  SUPPORTED_PLATFORMS,
  manifestPlatforms,
  platformName,
  platformSupported,
  unsupportedPlatformMessage,
} from '../driver/platform.js';

const pkg = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8')
);
const manifest = JSON.parse(
  readFileSync(new URL('../soundbase-plugin.json', import.meta.url), 'utf8')
);

test('package.json declares the platforms, in npm’s own field', () => {
  // npm enforces this on install (EBADPLATFORM), which is the earliest and
  // bluntest place the fact can be stated. Losing the field would silently
  // restore the full CI matrix.
  assert.ok(Array.isArray(pkg.os) && pkg.os.length > 0, 'package.json has no `os`');
  assert.deepEqual([...SUPPORTED_PLATFORMS], pkg.os);
  assert.deepEqual(pkg.os, ['darwin'], 'this plugin targets macOS only; see driver/platform.js');
  assert.ok(!pkg.os.includes('win32'), 'Windows is not supported; see driver/platform.js');
  assert.ok(pkg.os.includes(process.platform), 'the tests are running somewhere unsupported');
  assert.ok(platformSupported());
});

// The manifest says the same thing in the host's vocabulary. The Lab refuses a
// release that does not declare `platforms`, and the host installs only on a
// target it names — so it has to be there, and it has to agree with `os`, or
// the Desktop offers this plugin somewhere npm would have refused to install
// it (or hides it somewhere it works).
test('the manifest declares `platforms`, and they follow from `os`', () => {
  assert.ok(
    Array.isArray(manifest.platforms) && manifest.platforms.length > 0,
    'soundbase-plugin.json has no `platforms`; the Lab requires it'
  );
  assert.deepEqual(
    [...manifest.platforms].sort(),
    manifestPlatforms(PLUGIN_PLATFORMS).sort(),
    '`platforms` in soundbase-plugin.json disagrees with `os` in package.json'
  );
  for (const target of manifest.platforms) {
    assert.ok(PLUGIN_PLATFORMS.includes(target), `${target} is not a host target`);
    assert.ok(
      pkg.os.includes(target.split('-')[0]),
      `${target} is in the manifest but its OS is not in package.json`
    );
  }
  assert.ok(manifest.platforms.every((t) => t.startsWith('darwin-')));
  // the derivation itself: unrestricted means every target, an OS without a
  // Desktop build contributes nothing
  assert.deepEqual(manifestPlatforms(PLUGIN_PLATFORMS, []), [...PLUGIN_PLATFORMS]);
  assert.deepEqual(manifestPlatforms(PLUGIN_PLATFORMS, ['linux']), []);
});

test('an unsupported platform gets a reason, not a symptom', () => {
  assert.equal(platformSupported('win32'), false);
  const message = unsupportedPlatformMessage('win32');
  assert.match(message, /Windows/);
  // it has to say why, because "not supported" invites a bug report asking why
  assert.match(message, /Unix domain sockets/);
  for (const platform of SUPPORTED_PLATFORMS) {
    assert.ok(
      message.includes(platformName(platform)),
      `the message does not say ${platform} works`
    );
  }
});

// CI's `platforms` job runs scripts/ci-platforms.mjs on a bare checkout, with
// nothing installed, and every later job takes its runner from that output.
// An import from node_modules anywhere in that script's import graph breaks
// the whole run before a test has executed — and it did, once.
test('the CI platform script depends on nothing that needs installing', () => {
  for (const rel of ['../scripts/ci-platforms.mjs', '../driver/platform.js']) {
    const source = readFileSync(new URL(rel, import.meta.url), 'utf8');
    const specifiers = [...source.matchAll(/^\s*import[^'"]*['"]([^'"]+)['"]/gm)].map(
      (m) => m[1]
    );
    assert.ok(specifiers.length > 0, `${rel} has no imports to check`);
    for (const spec of specifiers) {
      assert.ok(
        spec.startsWith('node:') || spec.startsWith('.'),
        `${rel} imports ${spec}, which is not installed when CI computes its matrix`
      );
    }
  }
});

test('CI runs exactly the platforms that are declared', () => {
  const script = fileURLToPath(new URL('../scripts/ci-platforms.mjs', import.meta.url));
  const runners = JSON.parse(execFileSync(process.execPath, [script], { encoding: 'utf8' }));
  const expected = { darwin: 'macos-latest', linux: 'ubuntu-latest', win32: 'windows-latest' };

  assert.deepEqual(
    [...runners].sort(),
    SUPPORTED_PLATFORMS.map((p) => expected[p]).sort()
  );
  assert.ok(!runners.includes('windows-latest'));

  const primary = execFileSync(process.execPath, [script, '--primary'], {
    encoding: 'utf8',
  }).trim();
  assert.ok(runners.includes(primary), `${primary} is not in the matrix`);
});

// A Lab install carries the engine's source and no binary, so the plugin's own
// status is what tells the user to build it. main.js reports this from init()
// and every configUpdated(), and it has to clear once the user fixes it.
test('the plugin reports a missing engine as bad-config, and clears it', async () => {
  const { engineStatus } = await import('../driver/locate.js');
  const missing = engineStatus({ enginePath: '/nonexistent/engine' });
  assert.equal(missing.ok, false);
  assert.match(missing.message, /scripts\/build-engine\.mjs/);
  assert.match(missing.message, /cd "/, 'says which folder to run it in');
  assert.match(missing.message, /\/nonexistent\/engine/, 'names the path it looked at');
  const before = process.env.SB_USRP_MOCK;
  process.env.SB_USRP_MOCK = '1';
  try {
    assert.equal(engineStatus({}).ok, true, 'mock mode needs no build');
  } finally {
    if (before === undefined) delete process.env.SB_USRP_MOCK;
    else process.env.SB_USRP_MOCK = before;
  }
});
