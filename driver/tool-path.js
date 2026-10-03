// The PATH a plugin does not get when SoundBase is started from the Dock.
//
// A macOS app launched by Finder inherits launchd's PATH — /usr/bin:/bin:
// /usr/sbin:/sbin — not the one a login shell builds. Homebrew's bin is not on
// it, so `cmake` and `uhd_config_info` are "not installed" however many times
// the user installs them, and the plugin sits in needs-setup naming steps that
// are already done. Started from a terminal the same plugin is fine, which is
// why development never sees it.
//
// The fix is to look where package managers put things. The directories are
// appended, so a PATH that already finds a tool keeps finding that one.

import path from 'node:path';

/** Where cmake, ninja and UHD's tools land when a package manager installs them. */
export const TOOL_DIRS = Object.freeze({
  darwin: ['/opt/homebrew/bin', '/usr/local/bin', '/opt/local/bin'],
  linux: ['/usr/local/bin'],
});

/** `current` with this platform's tool directories added where they are missing. */
export function withToolDirs(current = '', platform = process.platform) {
  const dirs = String(current).split(path.delimiter).filter(Boolean);
  for (const dir of TOOL_DIRS[platform] ?? []) {
    if (!dirs.includes(dir)) dirs.push(dir);
  }
  return dirs.join(path.delimiter);
}

/**
 * Extend this process's PATH. Every child — the probes, the build script and
 * the cmake it runs — inherits the environment, so once is enough.
 */
export function extendToolPath(env = process.env, platform = process.platform) {
  env.PATH = withToolDirs(env.PATH, platform);
  return env.PATH;
}
