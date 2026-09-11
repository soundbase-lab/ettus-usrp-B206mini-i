// Which platforms this plugin runs on, declared once.
//
// The declaration is `os` in package.json — npm's own field, in
// `process.platform` vocabulary. Four things read it, so there is nothing to
// keep in step by hand:
//
//   npm install            refuses on an unsupported platform (EBADPLATFORM)
//   .github/workflows      builds its OS matrix from it (scripts/ci-platforms.mjs)
//   npm run doctor         says so, first, before anything else can confuse you
//   adapter.js             fails a device open with a sentence a user can act on
//   soundbase-plugin.json  carries the same fact as `platforms`, in the host's
//                          `<platform>-<arch>` vocabulary; the manifest is
//                          static, so a test and the doctor hold it to `os`
//                          (see manifestPlatforms below)
//
// This plugin targets macOS only. Windows is excluded for a specific reason
// rather than by neglect: the sweep engine is reached over a Unix domain
// socket and guards the radio with flock(2), neither of which Windows has,
// and Node cannot deliver a real SIGTERM there either — see
// docs/native-runtimes.md §6. Making it work is a port of the engine's IPC,
// not a configuration change. Linux would run the engine, but SoundBase
// Desktop does not ship there, so nothing would install the plugin.

import { readFileSync } from 'node:fs';
import { PLUGIN_PLATFORMS } from '@soundbase/plugin-contract';

const pkg = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8')
);

/** `process.platform` values this plugin supports. Empty means "anywhere". */
export const SUPPORTED_PLATFORMS = Object.freeze([...(pkg.os ?? [])]);

const NAMES = {
  aix: 'AIX',
  darwin: 'macOS',
  freebsd: 'FreeBSD',
  linux: 'Linux',
  openbsd: 'OpenBSD',
  sunos: 'illumos',
  win32: 'Windows',
};

/** A name a user recognises, falling back to whatever Node called it. */
export const platformName = (platform = process.platform) =>
  NAMES[platform] ?? platform;

export function platformSupported(platform = process.platform) {
  return (
    SUPPORTED_PLATFORMS.length === 0 || SUPPORTED_PLATFORMS.includes(platform)
  );
}

/**
 * Why this platform will not work, in a sentence that reaches the user as a
 * device status message. "listen EACCES" from the socket layer is the same
 * fact and tells nobody anything.
 */
export function unsupportedPlatformMessage(platform = process.platform) {
  const supported = SUPPORTED_PLATFORMS.map(platformName).join(' and ');
  return (
    `This plugin does not run on ${platformName(platform)}: its sweep engine ` +
    `needs Unix domain sockets and flock(2). Supported platforms: ${supported}.`
  );
}

/**
 * What the manifest's `platforms` has to say, derived from `os`.
 *
 * The host gates installs on `platforms`, which names SoundBase Desktop builds
 * as `<process.platform>-<process.arch>` and knows only the targets the
 * contract lists (`PLUGIN_PLATFORMS`). Every target whose OS is in `os`
 * belongs there, and nothing else: this plugin has nothing arch-specific — the
 * engine is compiled on the machine it runs on — so an OS is supported on
 * every architecture the Desktop ships for (macOS on Apple silicon and Intel).
 *
 * No `os` field means no restriction, which is every target.
 */
export function manifestPlatforms(os = SUPPORTED_PLATFORMS) {
  return PLUGIN_PLATFORMS.filter(
    (target) => os.length === 0 || os.includes(target.split('-')[0])
  );
}
