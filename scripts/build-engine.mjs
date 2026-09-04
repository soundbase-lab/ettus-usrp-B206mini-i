#!/usr/bin/env node
// Build the sweep engine that lives in engine/.
//
//   npm run build:engine            configure (if needed) and build
//   npm run build:engine -- --test  build, then run the engine's own unit tests
//   npm run build:engine -- --clean start from an empty build directory
//
// The binary lands at engine/build/engine, which is where the plugin looks for
// it first. Everything this needs is a system prerequisite — UHD is a USB
// driver layer that installs udev rules and downloads FPGA images, and is not
// something a plugin folder can carry:
//
//   macOS         brew install cmake ninja uhd
//   Debian/Pi     sudo apt install cmake ninja-build libuhd-dev uhd-host
//   then once     uhd_images_downloader -t b2xx

import { spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SOURCE = fileURLToPath(new URL('../engine', import.meta.url));
const BUILD = fileURLToPath(new URL('../engine/build', import.meta.url));

const args = process.argv.slice(2);
const withTests = args.includes('--test');
const clean = args.includes('--clean');

const fail = (msg, fix) => {
  process.stderr.write(`\n[build:engine] ${msg}\n${fix ? `  → ${fix}\n` : ''}`);
  process.exit(1);
};

const run = (cmd, argv, opts = {}) => {
  process.stdout.write(`$ ${cmd} ${argv.join(' ')}\n`);
  const res = spawnSync(cmd, argv, { stdio: 'inherit', cwd: ROOT, ...opts });
  if (res.error?.code === 'ENOENT') fail(`${cmd} is not installed`, prerequisite(cmd));
  if (res.status !== 0) fail(`${cmd} failed with status ${res.status}`);
};

const prerequisite = (cmd) =>
  process.platform === 'darwin'
    ? `brew install ${cmd === 'cmake' ? 'cmake ninja uhd' : cmd}`
    : `sudo apt install cmake ninja-build libuhd-dev uhd-host`;

const capture = (cmd, argv) => {
  const res = spawnSync(cmd, argv, { encoding: 'utf8' });
  return res.status === 0 ? res.stdout.trim() : null;
};

if (clean && existsSync(BUILD)) rmSync(BUILD, { recursive: true, force: true });

// Homebrew installs UHD somewhere CMake does not look by default.
const prefixPath =
  process.env.CMAKE_PREFIX_PATH ||
  (process.platform === 'darwin' ? capture('brew', ['--prefix']) : null);

const generator = spawnSync('ninja', ['--version']).status === 0 ? 'Ninja' : null;

const configure = [
  '-S',
  SOURCE,
  '-B',
  BUILD,
  '-DCMAKE_BUILD_TYPE=RelWithDebInfo',
  ...(generator ? ['-G', generator] : []),
  ...(prefixPath ? [`-DCMAKE_PREFIX_PATH=${prefixPath}`] : []),
];

if (!existsSync(`${BUILD}/CMakeCache.txt`)) run('cmake', configure);
run('cmake', ['--build', BUILD]);
if (withTests) run('ctest', ['--output-on-failure'], { cwd: BUILD });

process.stdout.write(`\n[build:engine] built ${BUILD}/engine\n`);
process.stdout.write(
  '[build:engine] check it sees your radio with `npm run find`\n'
);
