# Ettus USRP B206mini-i — SoundBase plugin

Turns an Ettus Research USRP B206mini-i into a live spectrum analyzer for
SoundBase: 70 MHz – 6 GHz, 6.25–200 kHz RBW, a 138 MHz UHF span swept in about
70 ms on USB 3. SoundBase spawns this plugin, the plugin spawns a C++ sweep
engine, and the engine owns the radio.

```
SoundBase ──spawns──► plugin (node) ──unix socket──► engine (C++/libuhd) ──USB──► B206mini-i
             HTTP                     frames + JSON
```

The sweeps it produces are what SoundBase draws on the plot and what its
coordination calculations exclude frequencies with, so the amplitudes are dBm
end to end and no sweep is ever averaged, held or reshaped on the way through.

---

## Requires UHD

UHD is a USB driver layer with udev rules and downloadable FPGA images. It is a
system prerequisite; no plugin folder can carry it.

```sh
brew install cmake ninja uhd                          # macOS
sudo apt install cmake ninja-build libuhd-dev uhd-host # Debian / Raspberry Pi OS
uhd_images_downloader -t b2xx                          # once, per machine
```

UHD **4.9 or newer** — the B206mini-i is not supported by earlier releases.
Check with `uhd_config_info --version`, and that the radio is seen at all with
`uhd_find_devices`.

## Build and try it

```sh
npm install
npm run build:engine     # compiles engine/ → engine/build/engine
npm run find             # what the plugin's discovery sees
npm run smoke            # boots, handshakes, sweeps, exactly as SoundBase does
```

With no radio to hand, everything above still works against a synthetic UHF
scene:

```sh
SB_USRP_MOCK=1 npm run smoke
SB_USRP_MOCK=1 npm start          # then curl it; the handshake line prints the port
```

Mock mode is also a checkbox in the plugin's settings inside SoundBase, which
is the honest way to demonstrate a coordination workflow with no radio in the
room. It never opens a USRP and never claims to have measured anything.

To use it for real, put this folder where SoundBase looks for plugins and
restart it — [docs/running-in-soundbase.md](docs/running-in-soundbase.md).

### Installing from the Lab

A release zip carries the engine's **source**, not a binary: the engine links
against whatever UHD is installed on your machine, and a binary built anywhere
else would not load against it (see *Why there is no prebuilt engine* below).
So after installing from the Lab there is one step to do once, in the plugin's
folder:

```sh
npm run build:engine
```

Until then the plugin shows **bad-config** in SoundBase's plugin manager with
that instruction as its status message, and lists no devices. Ticking
*Simulate a radio* in the plugin's settings clears it without a build, if you
want to see the plugin working first.

#### Why there is no prebuilt engine

It is not laziness. The engine links dynamically against libuhd, and the
binary has to match the UHD on the machine it runs on:

- GitHub's Ubuntu runners ship UHD **4.6**, below the 4.9 the B206mini-i
  needs, so a Linux build cannot even be produced there with system packages.
- A macOS build against Homebrew UHD hard-codes that dylib's path and version;
  a machine with UHD 4.9, or an Intel prefix, fails at load time with a
  message about a missing library.
- The Raspberry Pi target builds UHD from source into `/usr/local`.

Bundling libuhd itself is the thing
[docs/native-runtimes.md](docs/native-runtimes.md) tells you not to attempt.
Building where UHD lives is the honest option, and it takes about a minute.

## What it does

| | |
|---|---|
| **Range** | 70 MHz – 6 GHz, the B200-series tuning range |
| **RBW** | 6.25, 12.5, 25, 50, 100, 200 kHz — realised by the engine, echoed back as realised |
| **Cells** | the acquisition grid is `min(25 kHz, RBW)`; SoundBase's points are resampled from it |
| **Sweep rate** | ~70 ms for 138 MHz at 25 kHz RBW on USB 3; roughly 5× that on USB 2 |
| **Detector** | RMS average, positive peak, sample, negative peak |
| **Trace modes** | max-hold, min-hold and average are accumulated by the shell, at the engine's full sweep rate |
| **Levels** | dBm, from the engine's `K(gain)` model — see *About the amplitudes* below |

### Device controls

Beyond the settings SoundBase knows about (range, RBW, VBW, reference level,
point count), the plugin declares six of its own, which SoundBase renders
generically:

| Control | |
|---|---|
| **Gain** | `auto` derives the RX gain from the reference level (`g = −refLevel`, capped at 60 dB); `manual` uses the value below |
| **RX gain** | 0–76 dB, used in manual mode |
| **Dwell** | `fast`, `coordination`, `hq` — how long each sub-window is integrated for, and so how steady the trace is |
| **Detector** | which detector the reported trace comes from |
| **Antenna port** | `RX2` or `TX/RX` |
| **Acquisition profile** | sample rate and sub-window layout; `auto` picks from the USB link speed |

### Configuration

**Plugin settings** apply to every radio:

- **Engine binary** — blank uses `engine/build/engine`. Set it to use a build
  of your own, or one shared with a `usrp-scanner` checkout.
- **Level offset** — added to every amplitude, in dB. This is where feeder
  loss, an inline preamplifier or an attenuator gets corrected for.
- **Simulate a radio** — mock mode, as above.

**Device settings** address one radio:

- **Serial number** — as printed by `uhd_find_devices`. Blank means "the only
  USRP attached", which is the common case. Discovered devices fill this in
  themselves, and their ids (`usb:365C103`) are stable across restarts because
  a serial number is.

## About the amplitudes

Amplitude is `dBFS + K(gain)`, where `K` is the input power that produces full
scale. Out of the box that is the engine's built-in estimate, `K(g) = 10 − g`,
and the device reports itself as uncalibrated. That is fine for **relative**
work — finding what is occupied, comparing sweeps, watching a channel — and its
error grows as auto-gain backs off under a strong DTV signal.

For absolute levels you want a calibration against a known CW source, which the
engine can write into UHD's own power-calibration database:

```sh
engine/build/engine --calwrite cal.json
```

Until that has been run, treat the numbers as good relative measurements with an
uncertain offset, and use the plugin's **Level offset** to correct for anything
you know about your own feeder.

## How it is put together

```
adapter.js                the contract: discovery, configuration, sweeps
driver/
  engine-client.js        spawns the engine, supervises it, owns its socket
  frames.js               the engine's binary frame format
  plan.js                 geometry: engine cells ↔ SoundBase points
  locate.js               finding the engine binary, and finding radios
  fake-engine.js          the same wire, with no radio attached
engine/                   the C++ sweep engine (vendored — see below)
main.js                   shell bootstrap, byte-identical across every plugin
__tests__/                the contract, driven through the real shell
docs/engine-protocol.md   what goes over that socket
```

**The engine is a separate process on purpose.** libuhd owns a USB device and
can block in a call that never returns — a cable comes out mid-transfer, the
firmware stops answering — with no timeout to reach for. If that happened
inside the plugin process, SoundBase would see the health check stop, kill the
plugin and restart it, and every other device it serves would go with it.
Because it is a child process, its death is one device's problem: the driver
kills it, the device is marked failed with a message saying what happened, and
the next operation opens a fresh one. `__tests__/engine-failure.test.js` is that
sequence, with the fake engine exiting on cue.

### Where the engine came from

`engine/` is vendored from the [`usrp-scanner`](https://github.com/soundbase-lab/usrp-scanner)
project, which is where the sweep planner, the DSP, the stitching and the
calibration work were done and measured. It is a copy, not a submodule: this
plugin has to build from its own checkout. One deliberate addition lives here
and not there — `engine --find`, which enumerates attached radios by reading USB
descriptors without claiming one, so discovery can poll safely while a sweep is
running.

Pulling in engine changes from upstream is a copy of `apps/engine/` plus
re-applying that patch; `npm test` decodes golden frames emitted by the engine
binary itself, so a protocol change on the C++ side fails here rather than
producing a trace that is subtly wrong.

## Verifying a change

In order of what they prove:

```sh
npm run doctor       # is the plugin well-formed at all?
npm test             # the adapter through the real shell, over HTTP, against the fake engine
npm run manifest     # the manifest the host will accept or refuse
npm run find         # discovery, without SoundBase in the way
npm run smoke        # boots as a child process, handshakes, sweeps — with the real radio if one is attached
npm run build:engine -- --test    # the engine's own unit tests
```

`npm test` needs no hardware. `npm run smoke` uses whatever is attached, and
falls back to proving boot and handshake when nothing is.

## Platforms

Developed on macOS (Apple silicon, Homebrew UHD 4.10) and deployed on a
Raspberry Pi 5 running Raspberry Pi OS. Both are exercised regularly.

**Windows is not supported.** The engine is reached over a Unix domain socket
and guards the radio with `flock(2)`, neither of which Windows has; Node cannot
deliver a real `SIGTERM` there either. Supporting it means porting the engine's
IPC, not changing a setting. This is a real limitation, not an oversight
waiting to be tidied up.

That is declared once, as `os` in `package.json` — npm's own field:

- `npm install` refuses on any other platform, with npm's own `EBADPLATFORM`
- CI builds its OS matrix from it (`scripts/ci-platforms.mjs`), so there is no
  Windows job to fail
- `npm run doctor` reports it first, before every later check turns into noise
- the adapter refuses to open a device with that sentence, so a user sees the
  reason in the device's status instead of `listen EACCES` from the socket layer

To change the supported set, edit that one field; `__tests__/platform.test.js`
checks that everything downstream still agrees with it.

The radio wants a USB 3 port. On USB 2 everything still works — the plugin
detects the link speed and offers only the profiles that fit it — but sweeps
take roughly five times as long.

## Troubleshooting

| Symptom | |
|---|---|
| The plugin appears with no devices | `npm run find`. If that is empty, so is `uhd_find_devices`, and it is a cabling, power or UHD problem rather than a plugin one. |
| The device fails with "the sweep engine is not built" | `npm run build:engine`. |
| The device fails on open, mentioning UHD | Usually the FPGA image: run `uhd_images_downloader -t b2xx` once on that machine. |
| The device fails with "another engine holds …" | Something else has the radio — a `usrp-scanner` server, a second SoundBase, a leftover process. One engine per radio, by design. |
| The plugin does not appear at all | `npm run doctor`, then `npm run smoke`, then [docs/troubleshooting.md](docs/troubleshooting.md). A plugin whose handshake never arrives is simply invisible to the host. |

Anything the engine says at warning level or above is written to the plugin's
log, which SoundBase can open — including UHD's own overflow and timeout
complaints, which are the first sign of a USB port that cannot keep up.

## Cutting a release

The Release workflow publishes only from a **tag**; running it by hand
(`workflow_dispatch`) is a rehearsal that builds and uploads the zip as a
workflow artifact without creating a Release. To publish:

```sh
git tag v0.1.0 && git push origin v0.1.0
```

The tag must match `version` in both `soundbase-plugin.json` and
`package.json` — the pack step refuses otherwise. Then, in the Lab: *my
submissions → update release → v0.1.0*.

## Licence

BUSL-1.1 — see [LICENSE](LICENSE).
