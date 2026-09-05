// Finding the sweep engine, and finding radios with it.
//
// The engine binary is built from the vendored C++ in engine/ and lands in
// engine/build/. A user with their own build elsewhere can point at it with the
// plugin's `enginePath` setting or the SB_USRP_ENGINE environment variable —
// that is the escape hatch docs/native-runtimes.md asks for, and the reason
// this is a search rather than a constant.

import { execFile } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * The stand-in engine, used when the plugin is configured for mock mode. It is
 * a Node script rather than a binary; the driver runs it with this Node.
 */
export const FAKE_ENGINE = path.join(PLUGIN_ROOT, 'driver', 'fake-engine.js');

/** Where `npm run build:engine` puts the binary. */
export const BUILT_ENGINE = path.join(PLUGIN_ROOT, 'engine', 'build', 'engine');

export const BUILD_HINT =
  'run `npm run build:engine` (needs cmake, ninja and UHD 4.9 or newer), ' +
  'or set the plugin’s "Engine binary" setting to a build you already have';

const isFile = (p) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

/** True when the plugin has been asked to simulate a radio. */
export function mockRequested(pluginConfig = {}) {
  return (
    pluginConfig.mock === true ||
    process.env.SB_USRP_MOCK === '1' ||
    process.env.SB_USRP_MOCK === 'true'
  );
}

/**
 * The engine binary this plugin should run, or null if there is none yet.
 *
 * Explicit settings win outright, then the vendored build, then any build a
 * CMake preset left in engine/build/<preset>/ — that last one is what makes a
 * `cmake --preset pi-release` build work without reconfiguring the plugin.
 */
export function resolveEngineBinary(pluginConfig = {}) {
  if (mockRequested(pluginConfig)) return FAKE_ENGINE;

  const configured = String(pluginConfig.enginePath ?? '').trim();
  if (configured) return configured;

  const fromEnv = String(process.env.SB_USRP_ENGINE ?? '').trim();
  if (fromEnv) return fromEnv;

  if (isFile(BUILT_ENGINE)) return BUILT_ENGINE;

  const buildDir = path.dirname(BUILT_ENGINE);
  if (existsSync(buildDir)) {
    for (const entry of readdirSync(buildDir)) {
      const candidate = path.join(buildDir, entry, 'engine');
      if (isFile(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * Whether the plugin has an engine it can actually run — the plugin-level
 * answer main.js reports as its status, so a Lab install that has not been
 * built yet says so in the plugin manager rather than listing no devices.
 */
export function engineStatus(pluginConfig = {}) {
  const binPath = resolveEngineBinary(pluginConfig);
  if (!binPath) {
    return { ok: false, message: `The sweep engine is not built: ${BUILD_HINT}.` };
  }
  if (!isFile(binPath)) {
    return {
      ok: false,
      message: `The configured engine binary does not exist: ${binPath}. Clear the "Engine binary" setting to use the built-in one, or ${BUILD_HINT}.`,
    };
  }
  return { ok: true, message: '' };
}

/**
 * The USRPs attached right now, from `engine --find`.
 *
 * This reads USB descriptors only — it never claims a radio — so it is safe
 * while another engine is streaming from the same one. It is also the reason
 * discovery does not open anything: SoundBase polls this once a second while a
 * user has the device picker open.
 *
 * Anything that goes wrong is an empty list, not an error. A machine with no
 * USRP attached is the normal case, not a fault to log once a second.
 */
export function findRadios(binPath, { timeoutMs = 6000 } = {}) {
  return new Promise((resolve) => {
    if (!binPath || !isFile(binPath)) {
      resolve([]);
      return;
    }
    execFile(
      binPath,
      ['--find'],
      { timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 1 << 20 },
      (err, stdout) => {
        if (err && !stdout) {
          resolve([]);
          return;
        }
        const line = stdout
          .split('\n')
          .map((l) => l.trim())
          .reverse()
          .find((l) => l.startsWith('['));
        if (!line) {
          resolve([]);
          return;
        }
        try {
          const found = JSON.parse(line);
          resolve(Array.isArray(found) ? found.filter((d) => d && d.serial) : []);
        } catch {
          resolve([]);
        }
      }
    );
  });
}

/** UHD device arguments addressing one radio. */
export function deviceArgsFor(serial) {
  return serial ? `type=b200,serial=${serial}` : 'type=b200';
}
