# scanner engine (C++20)

> The sweep planner, the DSP, the stitching and the calibration in here were
> measured against a real B206mini-i; the design notes at the end record what
> was found. `engine --find` enumerates radios without claiming one, so the
> plugin's discovery can poll while a sweep is running. The golden frames in
> `../__tests__/fixtures/` catch a protocol change that the JavaScript side has
> not been told about.
>
> Build it from the plugin, not from here: `npm run build:engine` (add `--test`
> to run the unit tests below). The binary lands at `build/engine`, which is
> where the plugin looks for it.

Single owner of the USRP B206mini. Threads: `T_ctl` (all UHD control calls, sweep loop), `T_rx` (recv into a
lock-free ring, real-time priority), `T_dsp` (window + FFT + power accumulation + stitching), reader/writer for the
Unix socket, and a watchdog (`_exit(3)` when UHD blocks > 5 s or the stream dies). The wire is described in
[../docs/engine-protocol.md](../docs/engine-protocol.md).

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
| `engine --record out.frames [--seconds 30]` | log every frame to a file, length-prefixed exactly as the socket carries them; combines with `--socket`, so a capture taken while SoundBase drives the engine is the same file. Read it back with `node scripts/read-frames.mjs` |
| `engine --emit-fixtures ../__tests__/fixtures` | golden frames for the JavaScript codec tests |
| `engine --eqcap data/eq/usb2.eq.json --profile usb2 --sweeps 100` | flatness table on a 50 Ω load (milestone 3) |
| `engine --calwrite cal.json` | write UHD `pwr_cal` tables from CW measurements (milestone 3) |
| `engine --guardtest run/guard.json` | settle time after LO hops vs gain |

`--image-reject` alternates the LO grid each sweep and combines each sweep with the previous one,
keeping the quieter measurement of each cell. It removes receiver images — 25% of sweeps to none,
measured — for about 17% of the sweep rate. Capture `data/eq/<profile>.eq.json` with `--eqcap` first:
without it the two placements' own frequency responses combine into a level ripple of several dB.
See the `imageReject` section of `docs/engine-protocol.md`.

Three debug tools read what `--record` writes: `npm run frames -- FILE` prints one row per sweep
(gain, K, flags, median, p10, held cells); `npm run blocks -- FILE` reports how each 6 MHz
channel's level moved over the capture and says whether the movement is the receiver's (floor,
common mode or LO-grid parity moving) or the air's (channels moving independently — fading);
and `npm run viewer` draws the sweep on a page — live from the radio with image rejection on,
as the plugin runs it (`--no-image-reject` for the raw engine), or `-- --file FILE` to scrub a
capture. The viewer's lower plot keeps the p10 floor and the whole-trace median on separate
axes: in UHF the median is the DTV level and fades with the air, and is not the floor. None of
the three is part of the plugin.

Environment: `SCANNER_CLIP_DEBUG=1` logs per-window clipping. `UHD_LOG_FASTPATH_DISABLE=1` is set automatically.
A lock file (`--lock`, default `run/engine.lock`) refuses a second engine on the same device.

## Layout

`src/profile.*` rate/MCR/sub-window profiles · `src/sweep_planner.*` request → grid/LO/sub-window plan ·
`src/dsp.*` BH4 window, pffft, power-density cells · `src/stitch.*` grid, masks, spurs, equalisation ·
`src/cal*.{hpp,cpp}` K(gain, freq) models incl. UHD pwr_cal · `src/usrp.*` multi_usrp wrapper · `src/engine.*`
threads and sweep loop · `src/protocol.*` frame codec · `src/socket.*` UDS client · `src/main.cpp` CLI.

## Design notes, as measured

- FFT size rule tightened to Δf ≤ RBW/16 (≥ 16 fine bins per cell): with 8 bins a tone 3.5 kHz inside a cell edge
  lost 3 dB of its main lobe. At 8 MS/s / 25 kHz this gives N = 5120 (not 3840).
- Cells always integrate power density with fractional edge weights, so the realised RBW is exact for any N.
- The B200 accepts two pending timed commands; a third `set_rx_freq` blocks until the first executes (measured: the
  call time scaled exactly with the capture length). The sweep loop therefore keeps at most two timed DDC retunes
  outstanding (schedules sub-window k+2 once capture k is complete); calls then take 0.03–0.16 ms.
- Sweeps flagged as clipped are excluded from the server-side holds; auto-gain steps −3 dB per clipped sweep.
- Auto gain starts at min(cap, 30 dB) and creeps up, not at the cap: starting at the 50 dB cap next to strong DTV
  clipped for ~10 sweeps while the loop stepped down (2026-09-10).
- The DSP thread keeps a receive chunk until it is fully consumed. Releasing a partly used chunk made the next
  sub-window capture start up to one chunk (2 ms at 8 MS/s) late and run past its timed DDC retune, so every
  sub-window carried a −9 to −12 dB copy of the neighbouring window's spectrum shifted by one window width
  (a 500.31 MHz DTV pilot showed at 493.5 MHz in every usb2 sweep). A capture that still starts late is shortened
  to end on schedule and counted in `lateStarts`.
- Odd (interleaved) sweeps shift the LO grid by `Profile::altGridShiftHz`: half a hop step, or 5/16 of one on the
  profiles whose LO sits inside the kept band, so that each grid's LO and block edges fall in the flat part of the
  other's blocks (see `imageReject` in `docs/engine-protocol.md`). The earlier layout re-centred the shifted grid and
  moved it by a whole step, so odd sweeps reused the even LO frequencies plus one wasted hop.
- Every LO is kept ≥ 2.5 MHz from the internal spurs (n × 40 MHz reference, n × MCR) where the grid's centring
  slack allows it. An LO parked 0.85 MHz below 520 MHz showed an intermittent 0.7 MHz burst between the LO and
  the spur in 1 sweep of 13 (usb3-56, 470–616 MHz); the planner reports the shift as `loGridAutoShiftHz`.
