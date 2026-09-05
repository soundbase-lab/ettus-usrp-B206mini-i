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

import {
  SUPPORTED_PLATFORMS,
  platformName,
  platformSupported,
  unsupportedPlatformMessage,
} from '../driver/platform.js';

const pkg = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8')
);

test('package.json declares the platforms, in npm’s own field', () => {
  // npm enforces this on install (EBADPLATFORM), which is the earliest and
  // bluntest place the fact can be stated. Losing the field would silently
  // restore the full CI matrix.
  assert.ok(Array.isArray(pkg.os) && pkg.os.length > 0, 'package.json has no `os`');
  assert.deepEqual([...SUPPORTED_PLATFORMS], pkg.os);
  assert.ok(!pkg.os.includes('win32'), 'Windows is not supported; see driver/platform.js');
  assert.ok(pkg.os.includes(process.platform), 'the tests are running somewhere unsupported');
  assert.ok(platformSupported());
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
