// What the radio is trying to tell the user.
//
// The engine reports a status object once a second and a frame per sweep, and
// most of what is in them is for the engine's own author. A handful of fields
// are for the person looking at the plot — and those are the ones that decide
// whether the plot can be believed. This turns them into the contract's
// warnings: three severities, chosen from the reader's point of view:
//
//   info      worth knowing, the trace is fine    (uncalibrated levels, USB 2)
//   warning   the trace is degraded; act if it     (overload, USB overflows,
//             persists                              link timeouts, warm board)
//   critical  do not trust the trace right now,    (input above the never-exceed
//             or the hardware is at risk            level, a stalled radio, hot board)
//
// Everything here is pure. The adapter feeds it status frames, sweep frames
// and the clock, and asks for the current set; the shell diffs and publishes.
// A condition is listed while it holds and drops out when it clears — there
// is no history to reset, which is what makes "replace the whole set" safe.

/** The B206mini's never-exceed input is −15 dBm; SoundBase warns from −20. */
export const INPUT_WARN_DBM = -20;
export const INPUT_CRITICAL_DBM = -15;

/**
 * Board temperature from the RF sensor. The -i variant is rated to 85 °C
 * *ambient*, and the on-board sensor typically reads 15–20 °C above that, so
 * these sit well clear of a hot-but-normal rack. Conservative by design: a
 * temperature warning nobody can act on is noise, so this only speaks up when
 * the radio is genuinely at the edge of its rating.
 */
export const TEMP_WARN_C = 85;
export const TEMP_CRITICAL_C = 95;

/** A sweep this much later than the engine predicted is a stall, not a slow sweep. */
export const STALL_FACTOR = 3;
export const STALL_MIN_MS = 3_000;

const round1 = (v) => Math.round(v * 10) / 10;

export class WarningTracker {
  #status = null;
  #prevCounters = null;
  #deltas = { overflows: 0, timeouts: 0 };
  #sweeping = false;
  #lastSweepAt = 0;
  #sweepingSince = 0;
  #clipStreak = 0;

  /** The engine's once-a-second status. */
  onStatus(status, now = Date.now()) {
    const counters = {
      overflows: num(status.overflows),
      timeouts:
        num(status.timeouts) + num(status.captureTimeouts) + num(status.ringFull) + num(status.zeroRuns),
    };
    if (this.#prevCounters) {
      this.#deltas = {
        overflows: Math.max(0, counters.overflows - this.#prevCounters.overflows),
        timeouts: Math.max(0, counters.timeouts - this.#prevCounters.timeouts),
      };
    }
    this.#prevCounters = counters;
    this.#status = { ...status, at: now };
    // clipping is judged over consecutive reports, so one hot sweep during a
    // gain change does not flash a warning
    this.#clipStreak = num(status.clipFraction) > 0 ? this.#clipStreak + 1 : 0;
  }

  /** A completed sweep frame; only its arrival time matters here. */
  onSweep(now = Date.now()) {
    this.#lastSweepAt = now;
  }

  /** Whether the adapter has asked the engine to sweep. */
  setSweeping(sweeping, now = Date.now()) {
    if (sweeping && !this.#sweeping) {
      this.#sweepingSince = now;
      this.#lastSweepAt = 0;
    }
    this.#sweeping = sweeping;
  }

  /** The complete current set, most useful first. */
  current(now = Date.now()) {
    const s = this.#status;
    if (!s) return [];
    const out = [];

    // -- input level: the one that damages hardware, so it comes first
    const inputDbm = num(s.peakDbfs, Number.NaN) + num(s.kDbm, Number.NaN);
    if (Number.isFinite(inputDbm)) {
      if (inputDbm >= INPUT_CRITICAL_DBM) {
        out.push({
          id: 'input-level',
          severity: 'critical',
          message:
            `Input power is about ${round1(inputDbm)} dBm, above the radio's never-exceed level ` +
            `of ${INPUT_CRITICAL_DBM} dBm. Add attenuation or move the antenna now — this can damage the front end.`,
        });
      } else if (inputDbm >= INPUT_WARN_DBM) {
        out.push({
          id: 'input-level',
          severity: 'warning',
          message:
            `Input power is about ${round1(inputDbm)} dBm. Above ${INPUT_WARN_DBM} dBm the front end ` +
            'compresses and levels read low; add attenuation if a strong transmitter is nearby.',
        });
      }
    }

    // -- clipping: the trace has flat tops, and the holds exclude these sweeps
    if (this.#clipStreak >= 2) {
      out.push({
        id: 'overload',
        severity: 'warning',
        message:
          `Input overload: ${Math.round(num(s.clipFraction) * 100)}% of the last sweep clipped, so ` +
          'levels near strong signals read low and these sweeps are left out of max-hold. ' +
          'Lower the reference level, switch gain to manual and reduce it, or add attenuation.',
      });
    }

    // -- the USB link is not keeping up
    if (this.#deltas.overflows > 0) {
      out.push({
        id: 'usb-overflow',
        severity: 'warning',
        message:
          `${this.#deltas.overflows} sample overflow${this.#deltas.overflows === 1 ? '' : 's'} in the last second: ` +
          'the USB link is dropping samples and sweeps have gaps. Use a USB 3 port, a shorter cable, ' +
          'or a slower acquisition profile.',
      });
    } else if (this.#deltas.timeouts > 0) {
      out.push({
        id: 'link-timeouts',
        severity: 'warning',
        message:
          'The radio is answering late: capture timeouts in the last second. Sweeps are slower ' +
          'than planned. Check the USB connection and anything else on the same hub.',
      });
    }

    // -- stalled: status frames still arrive, sweeps do not
    if (this.#sweeping && s.sweeping !== false) {
      const predicted = num(s.plan?.predictedSweepMs, 500);
      const limit = Math.max(STALL_MIN_MS, predicted * STALL_FACTOR);
      const since = this.#lastSweepAt || this.#sweepingSince;
      const silentMs = since ? now - since : 0;
      if (silentMs > limit) {
        out.push({
          id: 'stalled',
          severity: 'critical',
          message:
            `The radio has stalled: no sweep has completed in ${Math.round(silentMs / 1000)} s ` +
            `(one was expected every ${Math.round(predicted)} ms). The plot is not updating. ` +
            'If this persists, unplug and reconnect the radio.',
        });
      }
    }

    // -- temperature
    const tempC = num(s.device?.tempC, Number.NaN);
    if (Number.isFinite(tempC)) {
      if (tempC >= TEMP_CRITICAL_C) {
        out.push({
          id: 'temperature',
          severity: 'critical',
          message:
            `The radio's board is at ${Math.round(tempC)} °C, beyond its rating. ` +
            'Stop sweeping and give it airflow before it fails.',
        });
      } else if (tempC >= TEMP_WARN_C) {
        out.push({
          id: 'temperature',
          severity: 'warning',
          message:
            `The radio's board is at ${Math.round(tempC)} °C. Give it airflow; levels drift ` +
            'as it heats and it will shut down if it gets much hotter.',
        });
      }
    }

    // -- the things worth knowing that do not degrade the trace
    if (s.calibrated === false) {
      out.push({
        id: 'uncalibrated',
        severity: 'info',
        message:
          'Levels are estimated from a built-in gain model, not a calibration. Relative readings ' +
          'and occupancy are fine; absolute dBm may be off by a few dB, more under a strong DTV signal.',
      });
    }
    if (num(s.device?.usbVersion, 3) < 3) {
      out.push({
        id: 'usb2',
        severity: 'info',
        message:
          'The radio is on a USB 2 link, so sweeps take about five times longer than on USB 3. ' +
          'A USB 3 port or cable fixes it.',
      });
    }
    return out;
  }
}

function num(v, fallback = 0) {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}
