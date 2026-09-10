// Where UHD's FPGA/firmware images are, and where the tool that fetches them is.
//
// A B2xx arrives over USB as an unprogrammed controller: UHD's discovery loads
// usrp_b200_fw.hex into it before the radio can even say its serial number.
// With no images folder, `uhd::device::find` returns an empty list — the
// orange power LED is on, and the plugin says "no device found". Debian's
// uhd-host package puts `uhd_images_downloader` on PATH; Homebrew installs it
// as lib/uhd/utils/uhd_images_downloader.py, off PATH, and needing a
// `requests` module its python does not have. scripts/install-images.mjs
// turns all of that into one command; the pure decisions live here so they
// can be tested without touching a machine.

import path from 'node:path';

/** What the B206mini-i needs in the images folder: the common firmware, and its FPGA image (shared with the B205mini). */
export const REQUIRED_IMAGES = ['usrp_b200_fw.hex', 'usrp_b205mini_fpga.bin'];

/** What `uhd_images_downloader` fetches when the script is run bare. */
export const DEFAULT_DOWNLOADER_ARGS = ['-t', 'b2xx'];

const UTILS_REL = path.join('lib', 'uhd', 'utils', 'uhd_images_downloader.py');

/**
 * Places the downloader may be, most specific first. The install that owns
 * `uhd_config_info` wins — its lib/uhd/utils is where its downloader is,
 * whatever prefix that install used — then the well-known prefixes.
 *
 * @param {object} o
 * @param {string[]} o.pathDirs      PATH entries, for a bare `uhd_images_downloader` (Linux)
 * @param {string|null} o.uhdConfigInfo  resolved path of uhd_config_info, or null
 * @param {string|null} o.brewPrefix  `brew --prefix uhd`, or null when there is no Homebrew
 */
export function downloaderCandidates({ pathDirs = [], uhdConfigInfo = null, brewPrefix = null }) {
  const out = [];
  for (const dir of pathDirs) if (dir) out.push(path.join(dir, 'uhd_images_downloader'));
  if (uhdConfigInfo) {
    // <prefix>/bin/uhd_config_info → <prefix>/lib/uhd/utils/…
    const prefix = path.dirname(path.dirname(uhdConfigInfo));
    out.push(path.join(prefix, UTILS_REL));
    out.push(path.join(prefix, 'lib64', 'uhd', 'utils', 'uhd_images_downloader.py'));
  }
  if (brewPrefix) out.push(path.join(brewPrefix, UTILS_REL));
  for (const prefix of ['/opt/homebrew/opt/uhd', '/usr/local', '/opt/local', '/usr']) {
    out.push(path.join(prefix, UTILS_REL));
    out.push(path.join(prefix, 'lib64', 'uhd', 'utils', 'uhd_images_downloader.py'));
  }
  return [...new Set(out)];
}

/** `uhd_config_info --images-dir` → the folder, or '' when UHD has none. */
export function parseImagesDir(output) {
  const m = /Images directory:\s*(.*)$/m.exec(output ?? '');
  return m ? m[1].trim() : '';
}

/**
 * Whether an images folder can program a B206mini-i.
 * @param {string} dir  '' when UHD reports none
 * @param {(p: string) => boolean} exists
 */
export function imagesState(dir, exists) {
  if (!dir) return { ok: false, dir, missing: [...REQUIRED_IMAGES] };
  const missing = REQUIRED_IMAGES.filter((f) => !exists(path.join(dir, f)));
  return { ok: missing.length === 0, dir, missing };
}
