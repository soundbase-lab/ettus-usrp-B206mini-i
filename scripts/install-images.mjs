#!/usr/bin/env node
// Install the FPGA and firmware images UHD needs to program a USRP B2xx.
//
//   npm run images                    from a checkout
//   node scripts/install-images.mjs   in an installed plugin folder
//   npm run images -- -t b2xx         any arguments replace the default `-t b2xx`
//
// Without the images the radio powers up (orange LED) but UHD's discovery
// never sees it, so the plugin reports no device. `brew install uhd` does not
// fetch them, and the downloader it installs is off PATH and needs a python
// module Homebrew's python lacks — the text a user would otherwise have to
// paste is exactly the kind that gets pasted wrong. So:
//
//   1. find uhd_images_downloader: on PATH, or the .py under lib/uhd/utils of
//      whichever UHD install owns uhd_config_info
//   2. find a python that can run it — the system one if it has `requests`,
//      otherwise a throwaway venv in the temp folder with `requests` in it
//   3. run the download; the downloader itself decides the folder
//      (UHD_IMAGES_DIR, else the install's own share/uhd/images)
//   4. check `uhd_config_info --images-dir` now names a folder with the files
//      the B206mini-i needs
//
// Homebrew keeps the images in the versioned Cellar folder, so `brew upgrade
// uhd` loses them: run this again afterwards.

import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  DEFAULT_DOWNLOADER_ARGS,
  downloaderCandidates,
  imagesState,
  parseImagesDir,
} from '../driver/uhd-images.js';

const say = (msg) => process.stdout.write(`[images] ${msg}\n`);
const fail = (msg, fix) => {
  process.stderr.write(`\n[images] ${msg}\n${fix ? `  → ${fix}\n` : ''}`);
  process.exit(1);
};

const capture = (cmd, argv, opts = {}) => {
  const r = spawnSync(cmd, argv, { encoding: 'utf8', timeout: 60_000, ...opts });
  return r.error || r.status !== 0 ? null : `${r.stdout}${r.stderr}`;
};

const pathDirs = (process.env.PATH ?? '').split(path.delimiter);
const onPath = (cmd) => {
  for (const dir of pathDirs) {
    const p = path.join(dir, cmd);
    if (dir && existsSync(p)) return p;
  }
  return null;
};
const real = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

if (process.platform === 'win32') fail('this plugin does not run on Windows.');

// 1. the downloader
const uhdConfigInfo = onPath('uhd_config_info');
if (!uhdConfigInfo) {
  fail(
    'UHD is not installed (no uhd_config_info on PATH).',
    process.platform === 'darwin'
      ? 'brew install uhd, then run this again'
      : 'sudo apt install libuhd-dev uhd-host, then run this again'
  );
}
const brewPrefix = process.platform === 'darwin' ? capture('brew', ['--prefix', 'uhd'])?.trim() : null;
const downloader = downloaderCandidates({
  pathDirs,
  uhdConfigInfo: real(uhdConfigInfo),
  brewPrefix: brewPrefix || null,
}).find((p) => existsSync(p));
if (!downloader) {
  fail(
    'found UHD but not its uhd_images_downloader.',
    'it normally lives next to UHD under lib/uhd/utils/; check how UHD was installed'
  );
}
say(`downloader: ${downloader}`);

// 2. a python that can run it
const python3 = onPath('python3');
if (!python3) fail('no python3 on PATH.', 'install Python 3 (Homebrew: brew install python), then run this again');
const hasRequests = (py) => spawnSync(py, ['-c', 'import requests'], { stdio: 'ignore' }).status === 0;

let python = python3;
if (!hasRequests(python3)) {
  const venv = path.join(tmpdir(), 'soundbase-uhd-images-venv');
  python = path.join(venv, 'bin', 'python');
  if (!(existsSync(python) && hasRequests(python))) {
    say(`python3 has no 'requests' module; making a throwaway venv in ${venv}`);
    let r = spawnSync(python3, ['-m', 'venv', '--clear', venv], { stdio: 'inherit' });
    if (r.status !== 0) fail('could not create a python venv.');
    r = spawnSync(python, ['-m', 'pip', '-q', 'install', 'requests'], { stdio: 'inherit' });
    if (r.status !== 0) fail("could not install 'requests' into the venv.", 'is this machine online?');
  }
}
say(`python: ${python}`);

// 3. the download
const extra = process.argv.slice(2);
const args = extra.length ? extra : DEFAULT_DOWNLOADER_ARGS;
say(`$ ${python} ${downloader} ${args.join(' ')}`);
const dl = spawnSync(python, [downloader, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
process.stdout.write(dl.stdout ?? '');
process.stderr.write(dl.stderr ?? '');
if (dl.status !== 0) {
  const text = `${dl.stdout}${dl.stderr}`;
  if (/Permission denied|PermissionError|Errno 13/.test(text)) {
    fail(
      'the images folder is not writable by you.',
      `run it with sudo: sudo node "${process.argv[1]}"${extra.length ? ` ${extra.join(' ')}` : ''}`
    );
  }
  fail(`uhd_images_downloader exited with status ${dl.status}.`);
}

// 4. did it land where UHD looks?
const dir = parseImagesDir(capture(uhdConfigInfo, ['--images-dir']));
const state = imagesState(dir, existsSync);
if (state.ok) {
  say(`done — UHD's images directory is ${dir} and it has the B206mini-i images.`);
  say('if the radio is attached, `uhd_find_devices` should now list it.');
  // This is the last thing the plugin's status asked for; say what happens
  // now, so nobody is left looking for a step that does not exist.
  const engine = fileURLToPath(new URL('../engine/build/engine', import.meta.url));
  if (existsSync(engine)) {
    say('the sweep engine is already built: SoundBase picks the images up by itself within 15 seconds.');
  } else {
    say('next, the sweep engine: if SoundBase is open it builds it by itself within 15 seconds and shows');
    say('progress as the plugin\'s status (it does the same the next time it starts). To build it now instead:');
    say(`  node "${fileURLToPath(new URL('./build-engine.mjs', import.meta.url))}"`);
  }
} else if (!dir) {
  fail(
    'the download finished but `uhd_config_info --images-dir` is still blank.',
    'set UHD_IMAGES_DIR to the folder the downloader printed above, or run again with -i <that folder>'
  );
} else {
  fail(`${dir} is missing ${state.missing.join(', ')}.`, 'run again with `-t b2xx` (the default) — a custom target left them out');
}
