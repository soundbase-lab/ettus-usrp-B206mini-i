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
brew install cmake ninja uhd
```

Then the FPGA and firmware images, once per machine. Without them a B2xx
powers up (orange LED) but is never programmed, and UHD's discovery returns
nothing — inside SoundBase the plugin's status says so and names this command.

```sh
npm run images                     # from a checkout
node scripts/install-images.mjs    # in an installed plugin folder
```

That wraps UHD's own `uhd_images_downloader -t b2xx`: it finds the downloader
wherever UHD put it (Homebrew installs it off PATH), gives it a python with
the `requests` module it needs (a throwaway venv when the system python has
none), and checks that `uhd_config_info --images-dir` ends up naming a folder
with `usrp_b200_fw.hex` in it. A blank answer there means the images were
never installed. On macOS they live in the versioned Cellar folder, so
**`brew upgrade uhd` loses them** — run it again afterwards. Arguments after
`--` replace the default `-t b2xx`.

UHD **4.9 or newer** — the B206mini-i is not supported by earlier releases.
Check with `uhd_config_info --version`, and that the radio is seen at all with
`uhd_find_devices`.

## Build and try it

```sh
npm install
npm run build:engine     # compiles engine/ → engine/build/engine
npm run images           # fetches UHD's FPGA/firmware images, once per machine
npm run find             # what the plugin's discovery sees
npm run smoke            # boots, handshakes, sweeps, exactly as SoundBase does
```

With no radio to hand, everything above still works against a synthetic UHF
scene:

```sh
SB_USRP_MOCK=1 npm run smoke
SB_USRP_MOCK=1 npm start          # then curl it; the handshake line prints the port
```

Mock mode is a development switch only: there is no setting for it inside
SoundBase, so a synthetic trace never stands in for a measured one.

## Running it in SoundBase

Users install the plugin from the **Lab**, which installs from this
repository's GitHub Releases — [docs/publishing.md](docs/publishing.md) has
the release workflow and the Lab's rules.

To run a working copy, quit SoundBase Desktop and start it with
`SB_PLUGIN_DIRS` set to the folder that *contains* this one:

```sh
# macOS — this checkout is ~/CODE/ettus-usrp-B206mini-i
SB_PLUGIN_DIRS="$HOME/CODE" open -a "SoundBase Desktop"
```

Run `npm install` first: SoundBase runs `main.js` as-is and installs nothing.
Seeing the device on the plot and reading the plugin's log are in
[docs/running-in-soundbase.md](docs/running-in-soundbase.md#seeing-a-device).

### The first run builds the engine

A release zip carries the engine's **source**, not a binary: the engine links
against whatever UHD is installed on your machine, and a binary built anywhere
else would not load against it (see *Why there is no prebuilt engine* below).
So the plugin **builds it on first run**, on your machine, and shows progress as
its own status in the plugin manager:

| Status | Meaning |
|---|---|
| *Building the sweep engine…* | compiling; about a minute the first time |
| *ok* | done; devices appear on the next enumeration |
| *needs setup: Installation incomplete: … needs cmake / UHD 4.9…* | run the numbered steps it names, in order (`brew install cmake ninja uhd`, then the images command). Leave SoundBase open: the plugin looks again every 15 s and starts the build by itself once the tools are there |
| *needs setup: Installation incomplete: … UHD has no images folder / is missing …* | the FPGA and firmware images are not installed, so no radio can ever be found. Run the `install-images.mjs` command it names; the status clears by itself within 15 s |
| *bad-config: the sweep engine failed to build: …* | the compiler's last lines; the message also gives the manual command for the full output. Change any plugin setting to try the build again, or build by hand — the plugin notices the binary by itself |

Nothing compiles if you'd rather it didn't: point **Engine binary** at a build
you already have (`<checkout>/engine/build/engine`). The manual equivalent, in the installed plugin's folder, is
`node scripts/build-engine.mjs` (`npm run build:engine` from a checkout).

#### Why there is no prebuilt engine

It is not laziness. The engine links dynamically against libuhd, and the
binary has to match the UHD on the machine it runs on:

- A macOS build against Homebrew UHD hard-codes that dylib's path and version;
  a machine with UHD 4.9, or an Intel prefix (`/usr/local` rather than
  `/opt/homebrew`), fails at load time with a message about a missing library.
- Homebrew moves UHD forward on its own schedule, so a binary built this month
  does not match the library installed next month.

Bundling libuhd itself is the thing
[docs/native-runtimes.md](docs/native-runtimes.md) tells you not to attempt.
Building where UHD lives is the honest option, and it takes about a minute.

## What it does

| | |
|---|---|
| **Range** | 70 MHz – 6 GHz, the B200-series tuning range |
| **RBW** | 6.25, 12.5, 25, 50, 100, 200 kHz — realised by the engine, echoed back as realised |
| **Points** | the trace *is* the acquisition grid, `min(25 kHz, RBW)` per cell — 5521 points across 470–608 MHz at 25 kHz. SoundBase's *points per sweep* setting is not a setting this radio takes: the plugin ignores it and echoes the cell count, so the form shows what the radio measured |
| **Reference level** | −60 to 0 dBm, default −50. In auto gain mode the RX gain is capped at `−refLevel` (never above 60 dB), the same method as usrp-scanner: −50 dBm means 50 dB of gain. Raise it when the overload warning appears |
| **Sweep rate** | ~70 ms for 138 MHz at 25 kHz RBW on USB 3; roughly 5× that on USB 2 |
| **Detector** | RMS average, positive peak, sample, negative peak |
| **Trace modes** | max-hold, min-hold and average are accumulated by the shell, at the engine's full sweep rate |
| **Levels** | dBm, from the engine's `K(gain)` model — see *About the amplitudes* below |

### Device controls

Beyond the settings SoundBase knows about (range, RBW, VBW), the plugin
declares seven of its own, which SoundBase renders generically:

| Control | |
|---|---|
| **Reference level** | the strongest input the trace should carry, −60 to 0 dBm. Also accepted as the contract's own `refLevelDbm` field; the control wins when both arrive, and a value outside the range is clamped and echoed |
| **Gain** | `auto` derives the RX gain from the reference level (`g = −refLevel`, capped at 60 dB) and creeps up from 30 dB, backing off if the front end clips; `manual` uses the value below |
| **RX gain** | 0–76 dB, used in manual mode |
| **Dwell** | `fast`, `coordination`, `hq` — how long each sub-window is integrated for, and so how steady the trace is |
| **Detector** | which detector the reported trace comes from |
| **Antenna port** | `RX2` or `TX/RX` |
| **Acquisition profile** | sample rate and sub-window layout; `auto` picks from the USB link speed |

### Warnings

The radio tells you when the plot should not be taken at face value. Each
condition is reported at one of three levels, which SoundBase shows as three
colours beside the device — on the plot's live-scan strip, in the live-scan
settings dialog, and in the plugin manager:

| Level | Meaning | Reported when |
|---|---|---|
| **Info** (blue) | worth knowing; the trace is fine | levels are uncalibrated · the radio is on a USB 2 link |
| **Warning** (amber) | the trace is degraded; act if it persists | input overload (clipping) · input above −20 dBm · sample overflows or capture timeouts on the USB link · board above 85 °C |
| **Critical** (red) | do not trust the trace right now, or the hardware is at risk | input above the −15 dBm never-exceed level · the radio has stalled (status arrives, sweeps do not) · board above 95 °C |

Each message says what is wrong and what to do about it. Warnings never change
the device's status — a device stays *ok* while overloaded — and a condition
disappears the moment it clears. The thresholds are named constants at the top
of [driver/warnings.js](driver/warnings.js). This needs SoundBase's plugin
contract 1.1; under an older host the plugin runs unchanged and the conditions
go unreported.

### Configuration

**Plugin settings** apply to every radio:

- **Engine binary** — blank uses `engine/build/engine`. Set it to use a build
  of your own.
- **Level offset** — added to every amplitude, in dB. This is where feeder
  loss, an inline preamplifier or an attenuator gets corrected for.

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
engine/                   the C++ sweep engine
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

`engine --find` enumerates attached radios by reading USB descriptors without
claiming one, so discovery can poll safely while a sweep is running. `npm test`
decodes golden frames emitted by the engine binary itself, so a protocol change
on the C++ side fails there rather than producing a trace that is subtly wrong.

## Verifying a change

In order of what they prove:

```sh
npm run doctor       # is the plugin well-formed at all?
npm test             # the adapter through the real shell, over HTTP, against the fake engine
npm run manifest     # the manifest the host will accept or refuse
npm run images       # UHD's FPGA/firmware images, once per machine (and after upgrading UHD)
npm run find         # discovery, without SoundBase in the way
npm run smoke        # boots as a child process, handshakes, sweeps — with the real radio if one is attached
npm run build:engine -- --test    # the engine's own unit tests
```

`npm test` needs no hardware. `npm run smoke` uses whatever is attached, and
falls back to proving boot and handshake when nothing is.

## Platforms

**macOS only**, on Apple silicon and Intel. Developed on Apple silicon with
Homebrew UHD 4.10; the engine is built on the machine it runs on, so an Intel
Mac with Homebrew UHD works the same way.

**Windows is not supported.** The engine is reached over a Unix domain socket
and guards the radio with `flock(2)`, neither of which Windows has; Node cannot
deliver a real `SIGTERM` there either. Supporting it means porting the engine's
IPC, not changing a setting. This is a real limitation, not an oversight
waiting to be tidied up.

**Linux is not a target.** The engine would build and run there, but SoundBase
Desktop does not ship for Linux, so nothing would install the plugin.

That is declared once, as `os` in `package.json` — npm's own field:

- `npm install` refuses on any other platform, with npm's own `EBADPLATFORM`
- CI builds its OS matrix from it (`scripts/ci-platforms.mjs`), so there is no
  Windows job to fail
- `npm run doctor` reports it first, before every later check turns into noise
- the adapter refuses to open a device with that sentence, so a user sees the
  reason in the device's status instead of `listen EACCES` from the socket layer

The manifest repeats it as `platforms`, in the host's `<platform>-<arch>`
vocabulary (`darwin-arm64`, `darwin-x64`): the Lab requires that field on a
release and SoundBase Desktop installs a plugin only on a target it names.

To change the supported set, edit `os`, then make `platforms` match;
`__tests__/platform.test.js` and `npm run doctor` check that everything
downstream — the manifest included — still agrees with it.

The radio wants a USB 3 port. On USB 2 everything still works — the plugin
detects the link speed and offers only the profiles that fit it — but sweeps
take roughly five times as long.

## Troubleshooting

| Symptom | |
|---|---|
| The plugin appears with no devices | `npm run find`. If that is empty, so is `uhd_find_devices`, and it is a cabling, power or UHD problem rather than a plugin one. |
| The device fails with "the sweep engine is not built" | `npm run build:engine`. |
| The device fails with "the sweep engine did not report a device within 90s" | The radio stopped answering while UHD opened it. The message says what UHD was doing when the wait ran out — nothing at all, still loading the FPGA image, or a named stage — and the fix is physical: unplug the radio, wait five seconds, plug it into a USB 3 port on the computer itself (no hub), try again. To watch the same open outside SoundBase: `uhd_usrp_probe --args "type=b200,serial=<serial>"` in a terminal, with SoundBase closed so nothing else holds the radio. A warm open takes about two seconds; the FPGA stays loaded until the radio is unplugged. Rebuilding the engine changes nothing here — UHD reads the images from disk at open time, nothing is compiled in. |
| Orange power LED, but `npm run find` and `uhd_find_devices` see nothing | The firmware image is missing: `uhd_config_info --images-dir` is blank or has no `usrp_b200_fw.hex`. `npm run images` (again after `brew upgrade uhd`). |
| The device fails on open, mentioning UHD | Usually the FPGA image (`usrp_b205mini_fpga.bin` for the B206mini-i): `npm run images`. |
| The device fails with "another engine holds …" | Something else has the radio — a second SoundBase, a leftover engine process, another UHD program. One engine per radio, by design. |
| The plugin does not appear at all | `npm run doctor`, then `npm run smoke`, then [docs/troubleshooting.md](docs/troubleshooting.md). A plugin whose handshake never arrives is simply invisible to the host. |

Anything the engine says at warning level or above is written to the plugin's
log, which SoundBase can open — including UHD's own overflow and timeout
complaints, which are the first sign of a USB port that cannot keep up.

## Licence

BUSL-1.1 — see [LICENSE](LICENSE).
