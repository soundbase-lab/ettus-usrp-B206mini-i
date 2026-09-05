# Working on this plugin with Claude

Context for Claude Code and any other coding agent working in this repository.
It is also the shortest accurate description of the plugin model here, so it is
worth reading yourself.

## What this repository is

A **SoundBase plugin** for the Ettus USRP B206mini-i: a small network service
that provides the radio to SoundBase over a versioned HTTP contract. SoundBase
spawns it as a child process and supervises it — handshake, health,
crash-restart, teardown. It in turn spawns a C++ sweep engine that owns the
radio through libuhd.

SoundBase is an RF coordination platform for live events: it plans which
frequencies hundreds of wireless microphones and in-ear monitors will use, and
coordinates against **measured** spectrum rather than assumptions. This plugin
supplies that measurement — its sweeps become the live trace on the plot, and
the amplitudes it reports decide which frequencies the software is willing to
use. `docs/soundbase.md` is the full orientation.

The author writes device logic. The author never writes UI, IPC, or HTTP.

```
soundbase-plugin.json   identity, products, config fields
main.js                 shell bootstrap — never edit
adapter.js              device logic — this is the file that changes
driver/
  engine-client.js      spawns and supervises the engine; owns its Unix socket
  frames.js             the engine's binary frame format
  plan.js               geometry: engine cells ↔ SoundBase points
  locate.js             finding the engine binary, and finding radios
  fake-engine.js        the same wire, with no radio attached
engine/                 the C++ sweep engine, vendored from usrp-scanner
__tests__/              contract tests through the real shell, plus golden frames
examples/network-analyzer/   a second complete plugin, over TCP, with a fake device
docs/                   the guide set; docs/README.md indexes it
scripts/                build-engine, find-radios, doctor, smoke, manifest, rename, release
```

`README.md` is the user-facing description; `docs/engine-protocol.md` is the
plugin↔engine wire.

## Invariants — do not violate these without being asked

- **Never edit `main.js`.** It is byte-identical across every first-party
  plugin and is the contract's entry point. Anything you are tempted to put
  there belongs in `adapter.js`. The single exception is adding a lifecycle
  hook (`init`, `configUpdated`, `destroy`) to the `Plugin` class body — and
  `this.config` is already threaded into both adapter exports, so that is
  rarely needed.
- **Never implement HTTP, routing, SSE, auth, or sweep bookkeeping.**
  `@soundbase/plugin-shell` owns all of it. If a change involves an HTTP verb,
  it is almost certainly wrong.
- **Never read a device address from machine-local state.** Addressing arrives
  explicitly in `device.config` on `POST /devices`. The same project opened on
  another machine must work.
- **Device ids must be stable across restarts.** They appear in URLs and are
  stored in users' projects. `usb:<path>` and `net:<host>` are the conventions.
- **Clamp, do not reject.** Out-of-range config gets snapped to what the
  hardware accepts and echoed back. Rejection looks like a broken plugin.
- **Every product the adapter announces must be declared in the manifest.** The
  two agree via `npm run rename`; a mismatch produces a device the host
  silently ignores. A test and `npm run doctor` both check it.
- **Do not accumulate trace modes.** The shell does max-hold, min-hold and
  average at the device's full sweep rate. Report raw sweeps.
- **Do not bump the `template` block** in `soundbase-plugin.json`. It records
  what this plugin was generated from and is meant to go stale.
- **No libuhd work in the plugin process.** Every UHD call happens inside the
  engine child process, so a wedged USB call kills one device rather than the
  plugin. Anything that would block this process on hardware belongs behind
  that boundary. `docs/native-runtimes.md` explains why in full.
- **Discovery must never claim the radio.** `engine --find` reads USB
  descriptors only; it is polled once a second while a device picker is open,
  sometimes while a sweep is running. Do not make discovery open a device,
  and do not make it noisy — nothing attached is a normal result.
- **A claimed radio is invisible to enumeration**, so `discoverDevices` merges
  in `openRadios`, and `open()` adds to it *before* spawning the engine. The
  shell removes a discovered device that discovery stops reporting and that has
  no adapter yet, which is exactly what a device is while it is opening. See
  `__tests__/discovery.test.js`; the symptom of getting it wrong is a device
  that works once and then 404s.
- **The two frame codecs must agree.** `engine/src/protocol.cpp` writes the
  format and `driver/frames.js` reads it. Change one and regenerate the golden
  frames (`engine/build/engine --emit-fixtures __tests__/fixtures`); a silent
  disagreement produces a trace that looks plausible and is wrong.
- **Platform support is declared once**, as `os` in `package.json`. npm
  enforces it on install, `scripts/ci-platforms.mjs` builds the CI matrix from
  it, `npm run doctor` checks it and `adapter.js` refuses an open with the
  reason. Do not hardcode a platform list anywhere else, and do not add a
  Windows job "to see": the engine needs Unix domain sockets and `flock(2)`.
- **Echo the engine's `applied`, never the request.** The engine quantises the
  span onto its grid, the RBW onto what the FFT realises and the gain to an
  integer. Its reply is the only account of what is really in force.

## The adapter contract

`adapter.js` exports exactly two things:

```js
export async function discoverDevices(pluginConfig) → Device[]
export function createSpectrumAnalyzerAdapter(device, pluginConfig) → {
  open()                 → { capabilities, identity }
  applyConfig(cfg)       → effective config, echoing what the device accepted
  startSweep(onTrace)    → calls onTrace(number[]) once per completed sweep
  stopSweep()
  close()
  onFatal                → assigned by the shell; call it when the transport dies
}
```

`docs/adapter-reference.md` is the detailed version. The normative
specification is installed, not guessed at:

```
node_modules/@soundbase/plugin-contract/spec/
  soundbase-plugin.schema.json
  core.openapi.yaml
  spectrum-analyzer.openapi.yaml
```

**Read those files before answering a question about the contract.** They ship
inside the dependency and always match the shell version in the lockfile, so
they are authoritative in a way that any summary — including this file — is not.

## Verifying a change

In order of what they prove:

```sh
npm run doctor       # is the plugin well-formed at all?
npm test             # adapter through the real shell, over HTTP, against the fake engine
npm run manifest     # the manifest the host will refuse or accept
npm run find         # discovery, without SoundBase in the way
npm run smoke        # boots as a child process, handshakes, sweeps — with the real radio if attached
npm run build:engine -- --test   # after any change under engine/
```

`npm test` needs no hardware: it sets `SB_USRP_MOCK=1`, which swaps the C++
engine for `driver/fake-engine.js` and leaves every other layer in place.

A change is not done because `npm test` passes. If it touches discovery,
startup or the manifest, run the smoke check — that is the path that fails
silently in production, because a plugin that never handshakes is simply
invisible to SoundBase. If it touches the engine or the frame format, build the
engine and run `npm test` again: the golden frames are decoded by the
JavaScript codec, so a C++ protocol change fails there.

## Prompts that work

**Adding a device control**

> Add a <name> control. Declare it in `capabilities.controls` from `open()`
> using the config-field vocabulary, map it to an engine plan field in
> `#controlPlan` with a clamp to what the engine accepts, and echo the settled
> value from the engine's `applied` reply. Add a test that a value outside the
> range comes back clamped rather than rejected, and one that a request
> carrying only this control leaves the others in force.

**Changing sweep geometry**

> Read `driver/plan.js` and the geometry section of
> `docs/engine-protocol.md` first. The engine sweeps its own grid and SoundBase
> wants exactly `pointCount` points; whatever `applyConfig` echoes and whatever
> `resampleTrace` produces have to be derived from the same numbers, or the
> trace draws at the wrong frequencies. Add the case to
> `__tests__/geometry.test.js`, which is where that class of bug is caught.

**Taking an engine change from usrp-scanner**

> Copy `apps/engine/` over `engine/`, re-apply the `--find` mode (it is this
> repository's only local change — see `engine/README.md`), rebuild with
> `npm run build:engine -- --test`, regenerate the golden frames with
> `engine/build/engine --emit-fixtures __tests__/fixtures`, and run `npm test`.
> If the frame tests fail, `driver/frames.js` needs the same change.

**Diagnosing "my radio does not appear in SoundBase"**

> Work outwards: `npm run find` (does the plugin's own enumeration see it?),
> then `uhd_find_devices` (does UHD?), then `npm run doctor` and `npm run
> smoke`. Check in this order: is the engine built; does the manifest validate;
> does the handshake line appear at all; does `GET /devices` return anything;
> does every device name a product the manifest declares. The host gives up on
> a plugin that does not handshake, and logs nothing that explains why.
> `docs/troubleshooting.md` has the full list.

**Renaming the plugin**

> Run `npm run rename <id>` rather than editing by hand — the id appears in the
> manifest, in every product's `deviceTypeId`, in `adapter.js`, and in
> `package.json`, and a partial rename produces a device the host ignores with
> only a warning line in the log.

## What not to ask for

- **A second transport.** WebSocket, gRPC and subscription protocols are all
  out of scope; the contract is HTTP plus SSE lifecycle events, deliberately.
- **UI.** Plugins do not ship renderer code. If a device needs a knob SoundBase
  has never heard of, that is `capabilities.controls`, which renders generically
  and needs no SoundBase release.
- **Changes to the shell.** If the shell seems to be in the way, that is worth
  raising as an issue rather than working around — a workaround in `adapter.js`
  becomes the thing that breaks on the next contract version.
- **Trace-mode maths, sweep ids, long-polling, or an SSE stream.** All of it is
  already implemented in the shell.
- **libuhd bindings in JavaScript.** A native addon puts the blocking USB call
  back inside the plugin process, which is the exact failure the engine child
  process exists to prevent.
- **Sharing one radio between two consumers.** A USRP has one RX path and one
  owner; the engine takes a lock file to enforce it. Two SoundBase devices on
  one serial, or this plugin alongside a running `usrp-scanner` server, is not
  a configuration to make work.
