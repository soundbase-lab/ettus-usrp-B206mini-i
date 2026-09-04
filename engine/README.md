# scanner engine (C++20)

> **Vendored.** This directory is a copy of `apps/engine/` from the
> [`usrp-scanner`](https://github.com/soundbase-lab/usrp-scanner) project, where
> the sweep planner, the DSP, the stitching and the calibration work were done
> and measured. It is a copy rather than a submodule because the plugin has to
> build from its own checkout. One change lives here and not upstream:
> `engine --find`, which enumerates radios without claiming one, so the plugin's
> discovery can poll while a sweep is running. Re-applying that patch is the
> whole cost of taking an upstream update; the golden frames in
> `../__tests__/fixtures/` catch a protocol change that the JavaScript side has
> not been told about.
>
> Build it from the plugin, not from here: `npm run build:engine` (add `--test`
> to run the unit tests below). The binary lands at `build/engine`, which is
> where the plugin looks for it.

Single owner of the USRP B206mini. Threads: `T_ctl` (all UHD control calls, sweep loop), `T_rx` (recv into a
lock-free ring, real-time priority), `T_dsp` (window + FFT + power accumulation + stitching), reader/writer for the
Unix socket, and a watchdog (`_exit(3)` when UHD blocks > 5 s or the stream dies). The wire is described in
[../docs/engine-protocol.md](../docs/engine-protocol.md); the design notes and measurements it came from are
PLAN.md sections 3–5 in the upstream `usrp-scanner` repository.

## Build

```bash
npm run build:engine --prefix ..            # what the plugin uses: builds into build/
npm run build:engine --prefix .. -- --test  # and runs the unit tests below

cmake --preset mac-dev && cmake --build --preset mac-dev && ctest --preset mac-dev   # by hand, macOS
cmake --preset pi-release && cmake --build --preset pi-release                       # by hand, Raspberry Pi 5
```

The presets build into `build/<preset>/`; the plugin finds a binary there too,
but `build/engine` is where it looks first.

## Run

| Command | Purpose |
|---|---|
| `engine --find [--args ARGS]` | list attached radios as JSON, reading USB descriptors only — never claims one, so it is safe while a sweep is running |
| `engine --probe [--cycles N]` | open/close cycles, prints serial, usb_version, link rate, temperature (milestone 0) |
| `engine --socket run/engine.sock` | serve the Node supervisor (server listens, engine connects) |
| `engine --profile usb2-simple --dump out.csv --sweeps 5 [--start 470 --stop 608 --rbw 25 --vbw 2.5 --gain 40 --dwell fast]` | CLI sweeps, WWB CSV of the last sweep, status JSON on stdout |
| `engine --emit-fixtures ../__tests__/fixtures` | golden frames for the JavaScript codec tests |
| `engine --eqcap data/eq/usb2.eq.json --profile usb2 --sweeps 100` | flatness table on a 50 Ω load (milestone 3) |
| `engine --calwrite cal.json` | write UHD `pwr_cal` tables from CW measurements (milestone 3) |
| `engine --guardtest run/guard.json` | settle time after LO hops vs gain |

Environment: `SCANNER_CLIP_DEBUG=1` logs per-window clipping. `UHD_LOG_FASTPATH_DISABLE=1` is set automatically.
A lock file (`--lock`, default `run/engine.lock`) refuses a second engine on the same device.

## Layout

`src/profile.*` rate/MCR/sub-window profiles · `src/sweep_planner.*` request → grid/LO/sub-window plan ·
`src/dsp.*` BH4 window, pffft, power-density cells · `src/stitch.*` grid, masks, spurs, equalisation ·
`src/cal*.{hpp,cpp}` K(gain, freq) models incl. UHD pwr_cal · `src/usrp.*` multi_usrp wrapper · `src/engine.*`
threads and sweep loop · `src/protocol.*` frame codec · `src/socket.*` UDS client · `src/main.cpp` CLI.

## Design notes that differ from the upstream PLAN.md as written

- FFT size rule tightened to Δf ≤ RBW/16 (≥ 16 fine bins per cell): with 8 bins a tone 3.5 kHz inside a cell edge
  lost 3 dB of its main lobe. At 8 MS/s / 25 kHz this gives N = 5120 (not 3840).
- Cells always integrate power density with fractional edge weights, so the realised RBW is exact for any N.
- The B200 accepts two pending timed commands; a third `set_rx_freq` blocks until the first executes (measured: the
  call time scaled exactly with the capture length). The sweep loop therefore keeps at most two timed DDC retunes
  outstanding (schedules sub-window k+2 once capture k is complete); calls then take 0.03–0.16 ms.
- Sweeps flagged as clipped are excluded from the server-side holds; auto-gain steps −3 dB per clipped sweep.
