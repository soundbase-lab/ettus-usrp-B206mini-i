# The engine protocol

What goes over the Unix domain socket between `driver/engine-client.js` and the
C++ engine in `engine/`. This is the private wire of this plugin — SoundBase
never sees it, and it is versioned by the vendored engine rather than by the
plugin contract.

The normative implementations are `engine/src/protocol.cpp` (which writes it)
and `driver/frames.js` (which reads it). The golden frames in
`__tests__/fixtures/` were produced by the first and are decoded by the second,
which is what keeps the two from drifting.

## Who connects to whom

The **plugin listens** and the **engine connects**:

```
plugin: net.createServer().listen('/tmp/sb-365C103-4711-1.sock')
plugin: spawn engine --socket <path> --lock <path>.lock --args type=b200,serial=365C103 --profile auto
engine: connect(), then frames until the socket closes
```

That way round because the plugin owns the lifetime: it can `SIGKILL` a wedged
engine and drop the socket, and the engine treats a closed socket as "exit". The
lock file beside the socket is the engine's own guard against two engines
touching one radio.

Commands go up the same socket as **one JSON object per line**. Frames come down
as **`u32` little-endian length followed by that many bytes**.

## Frames

All integers and floats are little-endian. Every frame is a 64-byte header
followed by either trace blocks or a UTF-8 JSON body. f32 payloads start on a
4-byte boundary, which is why the reassembler copies each frame into a fresh
buffer before decoding it.

### Header (64 bytes)

| Off | Type | Field | |
|---|---|---|---|
| 0 | u8 | magic | `0x53` |
| 1 | u8 | version | `1` |
| 2 | u8 | msgType | 1 trace complete, 2 trace partial, 3 status JSON, 4 log JSON |
| 3 | u8 | dtype | 0 f32 dB |
| 4 | u16 | flags | bit0 sweepComplete, bit1 overflowSeen, bit2 clipped, bit3 recalHappened, bit4 usb2, bit5 uncalibrated, bit6 interleaveParity, bit7 gainChanged |
| 6 | u8 | traceCount | trace blocks following the header |
| 8 | u32 | sweepId | increments per sweep |
| 12 | u32 | seq | engine sequence number |
| 16 | f64 | startHz | frequency of cell 0 |
| 24 | f64 | stepHz | cell spacing, `min(25 kHz, RBW)` |
| 32 | f64 | tDeviceS | device time at the end of the last completed LO position |
| 40 | u32 | binCount | cells per trace |
| 44 | f32 | rbwHz | the RBW actually realised |
| 48 | u32 | frameLength | total bytes including this header |
| 52 | f32 | gainDb | RX gain used for this sweep |
| 56 | f32 | kDbm | **dBm = cell value + kDbm** |
| 60 | u16 | navg | power averages per sub-window |
| 62 | u16 | profileId | acquisition profile |

`kDbm` is the field everything else depends on: cells are dBFS, and the plugin
adds `kDbm` (plus the user's level offset) to get the dBm SoundBase reports. It
travels per frame rather than per session because auto-gain can change it
between sweeps.

### Trace blocks

```
u8  detector    0 rms, 1 peak, 2 sample, 3 negative peak, 255 n/a
u8  kind        0 live-avg, 1 live-peak, 2 maxHold, 3 minHold, 4 avg, 5 mask, 6 live-min, 7 live-sample
u16 avgCount
u32 filledBins  cells valid so far; always binCount in a complete sweep
payload         binCount × f32 dBFS (NaN where there is no data),
                or binCount × u8 for the mask, zero-padded to a multiple of 4
```

Mask bits: 1 hole, 2 interpolated, 4 internal spur, 8 overflow-invalid,
16 clipped segment, 32 image-suspect, 64 LO hole, 128 reserved.

Per sweep the engine sends `live-avg`, plus `live-peak` — or `live-min` /
`live-sample` when that detector is selected — and the mask. **The plugin reads
one of them**, chosen by the `detector` control, and ignores the rest. It never
asks the engine for hold or average traces: the shell accumulates all four trace
modes in software at the engine's full sweep rate, which is the only place it
can be done without losing a transient nobody polled for.

Partial frames (msgType 2) are dropped. A half-finished sweep drawn as if it
were whole is a cliff on the plot.

### JSON frames

`status` (msgType 3) arrives once a second and after every applied plan. The
plugin uses `device` for its identity and capabilities, `plan` for the geometry
it echoes, and the arrival of the frames themselves as the health signal —
five seconds of silence means the engine is gone.

```json
{ "type": "status", "engineUp": true,
  "device": { "serial": "365C103", "usbVersion": 3, "gainRange": [0, 76],
              "fpga": "…", "fw": "…", "antenna": "RX2", "tempC": 44.1 },
  "plan": { "startHz": 470e6, "stopHz": 608e6, "stepHz": 25e3, "binCount": 5521,
            "rbwHz": 25000, "vbwHz": 2500, "gainMode": "auto", "gainDb": 50,
            "refLevelDbm": -50, "dwell": "coordination", "detector": "rms",
            "antenna": "RX2", "profile": "usb3-56" },
  "sweeping": true, "sweepId": 1234, "kDbm": -40, "calibrated": false }
```

`applied` (msgType 3) answers every `setPlan`, immediately, whether or not a
sweep is in progress:

```json
{ "type": "applied", "requested": { … }, "applied": { … }, "warnings": ["startHz snapped to 470.000 MHz"] }
```

**`applied` is what the plugin echoes to SoundBase.** The engine quantises what
it was asked for — the span onto the output grid, the RBW onto what the FFT can
realise, the gain to an integer within the profile's window — and its answer is
the only account of what is really in force.

`log` (msgType 4) is `{ "type": "log", "level": "info|warn|error", "msg": "…" }`.
Warnings and errors reach the plugin's log; info does not.

## Commands

```json
{ "cmd": "setPlan", "plan": { "startHz": 470e6, "stopHz": 608e6, "rbwHz": 25000, "vbwHz": 2500,
    "dwell": "fast|coordination|hq", "gainMode": "auto|manual", "gainDb": 50, "refLevelDbm": -50,
    "profile": "auto|usb2|usb2-simple|usb2-turbo|usb3-16|usb3-28|usb3-32|usb3-56",
    "detector": "rms|peak|sample|min", "antenna": "RX2|TX/RX", "mode": "continuous|single" } }
{ "cmd": "start" }      // sweep continuously with the current plan
{ "cmd": "stop" }       // stop after the current LO position (~100 ms)
{ "cmd": "single" }     // one sweep, then stop
{ "cmd": "getStatus" }  // an immediate status frame
{ "cmd": "shutdown" }   // graceful exit
```

Every field of `plan` is optional and missing fields keep their current value,
which is exactly the shape `applyConfig`'s patch semantics need. A plan sent
while sweeping takes effect at the next sweep boundary — so a frame already in
flight can still carry the old grid, and the adapter drops any frame whose
`startHz`/`stepHz`/`binCount` do not match the configuration it is currently
reporting.

## Command-line modes the plugin uses

| | |
|---|---|
| `engine --socket PATH --lock PATH --args ARGS --profile auto` | the normal one: serve the plugin |
| `engine --find [--args ARGS]` | list attached radios as JSON, without claiming one — this plugin's own addition to the vendored engine. It cannot see a radio an engine already has open: a claimed B200 does not answer enumeration, which is why `adapter.js` keeps its own list of claimed radios |
| `engine --emit-fixtures DIR` | write the golden frames in `__tests__/fixtures/` |

`engine --probe`, `--dump`, `--eqcap`, `--calwrite` and `--guardtest` exist for
bring-up and calibration work by hand; see `engine/README.md`.
