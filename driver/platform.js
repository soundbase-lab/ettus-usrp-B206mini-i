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
//
// Windows is excluded for a specific reason rather than by neglect: the sweep
// engine is reached over a Unix domain socket and guards the radio with
// flock(2), neither of which Windows has, and Node cannot deliver a real
// SIGTERM there either — see docs/native-runtimes.md §6. Making it work is a
// port of the engine's IPC, not a configuration change.

import { readFileSync } from 'node:fs';

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
