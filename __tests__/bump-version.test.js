// One version, three files. The release workflow refuses a tag whose version
// differs from the manifest, so the bump has to move all three together — and
// keep the manifest's formatting, because the doctor and the Lab read it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCRIPT = path.join(ROOT, 'scripts', 'bump-version.mjs');

function sandbox() {
  const dir = mkdtempSync(path.join(tmpdir(), 'bump-'));
  for (const f of ['package.json', 'package-lock.json', 'soundbase-plugin.json']) {
    cpSync(path.join(ROOT, f), path.join(dir, f));
  }
  return dir;
}
const versionsIn = (dir) => ({
  pkg: JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')).version,
  lock: JSON.parse(readFileSync(path.join(dir, 'package-lock.json'), 'utf8')).version,
  manifest: JSON.parse(readFileSync(path.join(dir, 'soundbase-plugin.json'), 'utf8')).version,
});
const bump = (dir, arg) =>
  execFileSync(process.execPath, [SCRIPT, arg], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

test('patch, minor, major and an explicit version move all three files together', (t) => {
  const dir = sandbox();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const start = versionsIn(dir);
  assert.equal(start.pkg, start.manifest, 'the fixture itself must agree');
  const [maj, min, pat] = start.pkg.split('.').map(Number);

  assert.equal(bump(dir, 'patch'), `${maj}.${min}.${pat + 1}`);
  assert.equal(bump(dir, 'minor'), `${maj}.${min + 1}.0`);
  assert.equal(bump(dir, 'major'), `${maj + 1}.0.0`);
  assert.equal(bump(dir, '4.5.6'), '4.5.6');
  assert.deepEqual(versionsIn(dir), { pkg: '4.5.6', lock: '4.5.6', manifest: '4.5.6' });
});

test('the manifest keeps its formatting; only the version line changes', (t) => {
  const dir = sandbox();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const before = readFileSync(path.join(dir, 'soundbase-plugin.json'), 'utf8');
  bump(dir, 'patch');
  const after = readFileSync(path.join(dir, 'soundbase-plugin.json'), 'utf8');
  const changed = before.split('\n').filter((line, i) => line !== after.split('\n')[i]);
  assert.equal(changed.length, 1, `expected one changed line, got ${changed.length}`);
  assert.match(changed[0], /"version"/);
});

test('a bad argument is refused before anything is written', (t) => {
  const dir = sandbox();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const before = versionsIn(dir);
  for (const bad of ['1.2', 'latest', 'v1.2.3', '']) {
    assert.throws(() => bump(dir, bad), /usage/);
  }
  assert.deepEqual(versionsIn(dir), before);
});
