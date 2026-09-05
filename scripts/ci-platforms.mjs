#!/usr/bin/env node
// The GitHub runners this plugin's CI should use, from `os` in package.json.
//
//   node scripts/ci-platforms.mjs             ["ubuntu-latest","macos-latest"]
//   node scripts/ci-platforms.mjs --primary   ubuntu-latest
//
// `--primary` is the single runner for jobs that only need one (booting the
// plugin, cutting a release). It prefers Linux, which is the cheapest and
// least contended runner, and falls back to whatever else is supported.
//
// .github/workflows/ci.yml reads this into its matrix, so the platforms a
// plugin supports are declared once — in package.json, where npm itself
// enforces them — instead of in a workflow matrix that drifts away from the
// truth and fails on a platform nobody intended to support.
//
// A plugin with no `os` field supports everything, and gets the full matrix.

import { SUPPORTED_PLATFORMS, platformName } from '../driver/platform.js';

/** `process.platform` → the runner label that provides it. */
const RUNNERS = {
  linux: 'ubuntu-latest',
  darwin: 'macos-latest',
  win32: 'windows-latest',
};

const wanted = SUPPORTED_PLATFORMS.length
  ? SUPPORTED_PLATFORMS
  : Object.keys(RUNNERS);

const runners = [];
for (const platform of wanted) {
  const runner = RUNNERS[platform];
  if (runner) runners.push(runner);
  else {
    // Not a failure: a plugin may legitimately support a platform GitHub does
    // not host. Say so rather than dropping it silently.
    process.stderr.write(
      `no GitHub-hosted runner for ${platformName(platform)}; not covered by CI\n`
    );
  }
}

if (runners.length === 0) {
  process.stderr.write(
    'none of the supported platforms has a GitHub-hosted runner\n'
  );
  process.exit(1);
}

if (process.argv.includes('--primary')) {
  const primary = runners.includes('ubuntu-latest') ? 'ubuntu-latest' : runners[0];
  process.stdout.write(`${primary}\n`);
} else {
  process.stdout.write(`${JSON.stringify(runners)}\n`);
}
