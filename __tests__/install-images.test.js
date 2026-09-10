// The decisions behind `npm run images`, without a machine to make them on.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  REQUIRED_IMAGES,
  downloaderCandidates,
  imagesState,
  parseImagesDir,
} from '../driver/uhd-images.js';

test('the UHD install that owns uhd_config_info is searched before well-known prefixes', () => {
  const c = downloaderCandidates({
    pathDirs: ['/usr/bin'],
    uhdConfigInfo: '/opt/homebrew/Cellar/uhd/4.10.0.0_2/bin/uhd_config_info',
    brewPrefix: '/opt/homebrew/opt/uhd',
  });
  assert.equal(c[0], '/usr/bin/uhd_images_downloader', 'a bare command on PATH (Linux uhd-host) wins outright');
  assert.equal(c[1], '/opt/homebrew/Cellar/uhd/4.10.0.0_2/lib/uhd/utils/uhd_images_downloader.py');
  assert.ok(c.includes('/opt/homebrew/opt/uhd/lib/uhd/utils/uhd_images_downloader.py'));
  assert.ok(c.includes('/usr/lib/uhd/utils/uhd_images_downloader.py'));
  assert.equal(new Set(c).size, c.length, 'no duplicates');
});

test('with no uhd_config_info and no Homebrew the well-known prefixes are still tried', () => {
  const c = downloaderCandidates({ pathDirs: [], uhdConfigInfo: null, brewPrefix: null });
  assert.ok(c.length > 0);
  assert.ok(c.every((p) => p.endsWith('uhd_images_downloader.py')));
});

test('a blank images dir — the "orange LED, no device" machine — is parsed as none', () => {
  assert.equal(parseImagesDir('Images directory: \n'), '');
  assert.equal(parseImagesDir('Images directory: /opt/homebrew/Cellar/uhd/4.10.0.0_2/share/uhd/images\n'),
    '/opt/homebrew/Cellar/uhd/4.10.0.0_2/share/uhd/images');
  assert.equal(parseImagesDir(null), '');
});

test('the B206mini-i needs the common firmware and the B205mini FPGA image', () => {
  assert.deepEqual(imagesState('', () => true), { ok: false, dir: '', missing: REQUIRED_IMAGES });
  const onlyFw = new Set(['/img/usrp_b200_fw.hex']);
  assert.deepEqual(imagesState('/img', (p) => onlyFw.has(p)), {
    ok: false,
    dir: '/img',
    missing: ['usrp_b205mini_fpga.bin'],
  });
  assert.equal(imagesState('/img', () => true).ok, true);
});
