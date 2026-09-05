// Owning the engine process.
//
// The engine is a C++ program that opens the USRP with libuhd and streams. A
// blocking USB call inside it can wedge for good — a cable comes out mid
// transfer, the firmware stops answering — and there is no timeout to reach
// for. That is the whole reason it is a separate process: when it stops
// answering, this file kills it and reports a device error, and the plugin
// itself stays responsive so SoundBase never has to restart it and the user's
// other devices are untouched. See docs/native-runtimes.md.
//
// The wire is the engine's own: this side listens on a Unix domain socket, the
// engine connects to it, commands go up as one JSON object per line and frames
// come down length-prefixed. Nothing here respawns anything — a dead engine is
// reported through `onFatal`, and the shell reopens the device on the next
// operation, which is the contract's way of doing this.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FrameReassembler, MsgType, decodeFrame } from './frames.js';

/** UHD opens the radio, downloads the FPGA image if needed, and plants cal points. */
const STARTUP_TIMEOUT_MS = 30_000;
/** The engine sends status once a second; this much silence means it is gone. */
const HEALTH_TIMEOUT_MS = 5_000;
/** `setPlan` is answered by an `applied` frame immediately, sweeping or not. */
const APPLY_TIMEOUT_MS = 10_000;
/** How long a `shutdown` command gets before SIGKILL. */
const SHUTDOWN_GRACE_MS = 2_000;
/** macOS caps a Unix socket path at 104 bytes, and says nothing useful if you exceed it. */
const MAX_SOCKET_PATH = 100;

let socketCounter = 0;

export class EngineError extends Error {
  name = 'EngineError';
}

export class EngineClient {
  /** Called with each complete sweep frame. */
  onSweep = null;
  /** Called once when the engine dies or stops answering, never for a requested stop. */
  onFatal = null;
  /** Called with { level, msg } for anything the engine says. */
  onLog = null;

  #child = null;
  #server = null;
  #conn = null;
  #healthTimer = null;
  #applyWaiters = [];
  #stderrTail = [];
  #stopping = false;
  #dead = false;
  /** Set only between spawn and the first status: start()'s two exits. */
  #onReady = null;
  #onEarlyExit = null;

  /** Latest engine status object, or null before the first one arrives. */
  status = null;

  constructor({ binPath, deviceArgs, eqDir, tag = 'usrp', log }) {
    this.binPath = binPath;
    this.deviceArgs = deviceArgs;
    this.eqDir = eqDir;
    this.onLog = log ?? null;
    socketCounter += 1;
    const stem = path.join(tmpdir(), `sb-${tag}-${process.pid}-${socketCounter}`);
    const short = stem.length + 5 > MAX_SOCKET_PATH;
    const base = short
      ? path.join('/tmp', `sb-${process.pid}-${socketCounter}`)
      : stem;
    this.socketPath = `${base}.sock`;
    this.lockPath = `${base}.lock`;
  }

  get running() {
    return this.#child !== null && !this.#dead;
  }

  /**
   * Spawn the engine and resolve once it reports a device — which is the point
   * at which the radio is known to be open and answering. Rejects with what the
   * engine printed on the way out, because "no UHD device found" is the message
   * the user needs and `spawn` alone never produces it.
   */
  async start() {
    if (this.#server) return this.status;
    if (!existsSync(this.binPath)) {
      throw new EngineError(
        `the sweep engine is not built: ${this.binPath} does not exist. ` +
          'Run `npm run build:engine` in the plugin directory (it needs cmake and UHD 4.9+).'
      );
    }
    await this.#listen();
    // stop() can arrive while the socket is still being set up — a device added
    // and removed in the same second. Spawning after that point produces an
    // engine nobody holds a reference to, which keeps the radio for the life of
    // the plugin and, in a test run, keeps the process alive for ever.
    if (this.#stopping) {
      throw new EngineError('the sweep engine was shut down while starting');
    }

    const ready = new Promise((resolve, reject) => {
      let settled = false;
      const finish = (err, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.#onReady = null;
        this.#onEarlyExit = null;
        if (err) reject(err);
        else resolve(value);
      };
      const timer = setTimeout(() => {
        finish(
          new EngineError(
            `the sweep engine did not report a device within ${STARTUP_TIMEOUT_MS / 1000}s. ` +
              this.#tail()
          )
        );
      }, STARTUP_TIMEOUT_MS);
      timer.unref?.();
      this.#onReady = (status) => finish(null, status);
      this.#onEarlyExit = (reason) =>
        finish(new EngineError(`${reason}. ${this.#tail()}`));
    });

    this.#spawn();
    try {
      return await ready;
    } catch (err) {
      await this.stop();
      throw err;
    }
  }

  /** Send a plan and resolve with the engine's `applied` echo. */
  async setPlan(plan) {
    if (!this.#conn) {
      throw new EngineError('the sweep engine is not connected');
    }
    const applied = new Promise((resolve, reject) => {
      const waiter = { resolve, reject };
      const timer = setTimeout(() => {
        this.#applyWaiters = this.#applyWaiters.filter((w) => w !== waiter);
        reject(new EngineError('the sweep engine did not acknowledge the plan'));
      }, APPLY_TIMEOUT_MS);
      timer.unref?.();
      waiter.done = () => clearTimeout(timer);
      this.#applyWaiters.push(waiter);
    });
    this.send({ cmd: 'setPlan', plan });
    return applied;
  }

  send(command) {
    if (!this.#conn || this.#conn.destroyed) return false;
    this.#conn.write(`${JSON.stringify(command)}\n`);
    return true;
  }

  /** Stop the engine and release everything. Safe to call twice. */
  async stop() {
    this.#stopping = true;
    this.#clearHealthTimer();
    for (const waiter of this.#applyWaiters.splice(0)) {
      waiter.done?.();
      waiter.reject(new EngineError('the sweep engine was shut down'));
    }
    const child = this.#child;
    this.#child = null;
    if (child && child.exitCode === null && child.signalCode === null) {
      this.send({ cmd: 'shutdown' });
      const exited = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve(false), SHUTDOWN_GRACE_MS);
        timer.unref?.();
        child.once('exit', () => {
          clearTimeout(timer);
          resolve(true);
        });
      });
      if (!exited) child.kill('SIGKILL');
    }
    this.#conn?.destroy();
    this.#conn = null;
    if (this.#server) {
      const server = this.#server;
      this.#server = null;
      // Teardown must not be able to hang: SoundBase is waiting on it, and a
      // socket that will not close is not worth blocking a shutdown for.
      await Promise.race([
        new Promise((resolve) => server.close(resolve)),
        new Promise((resolve) => setTimeout(resolve, 1000).unref?.()),
      ]);
    }
    for (const file of [this.socketPath, this.lockPath]) {
      try {
        if (existsSync(file)) unlinkSync(file);
      } catch {
        // a leftover socket file is not worth failing a teardown over
      }
    }
  }

  // --------------------------------------------------------------------------

  async #listen() {
    mkdirSync(path.dirname(this.socketPath), { recursive: true });
    if (existsSync(this.socketPath)) unlinkSync(this.socketPath);
    const server = net.createServer((socket) => this.#onConnection(socket));
    server.unref?.();
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.socketPath, () => {
        server.off('error', reject);
        server.on('error', (err) => this.#log('warn', err.message));
        resolve();
      });
    });
    this.#server = server;
  }

  #spawn() {
    if (this.#stopping) return;
    const args = [
      '--socket',
      this.socketPath,
      '--lock',
      this.lockPath,
      '--args',
      this.deviceArgs,
      '--profile',
      'auto',
    ];
    if (this.eqDir) args.push('--eq-dir', this.eqDir);

    // The fake engine is a script, not a binary: run it with this Node rather
    // than relying on an executable bit that a zipped release can lose.
    const isScript = this.binPath.endsWith('.js');
    const command = isScript ? process.execPath : this.binPath;
    const argv = isScript ? [this.binPath, ...args] : args;

    let child;
    try {
      child = spawn(command, argv, {
        stdio: ['ignore', 'ignore', 'pipe'],
        env: {
          ...process.env,
          UHD_LOG_FASTPATH_DISABLE: process.env.UHD_LOG_FASTPATH_DISABLE ?? '1',
        },
      });
    } catch (err) {
      this.#onEarlyExit?.(`could not start the sweep engine: ${err.message}`);
      return;
    }
    this.#child = child;
    child.stderr.setEncoding('utf8');
    let partial = '';
    child.stderr.on('data', (chunk) => {
      partial += chunk;
      const lines = partial.split('\n');
      partial = lines.pop() ?? '';
      for (const line of lines) {
        const msg = line.trimEnd();
        if (!msg) continue;
        this.#stderrTail.push(msg);
        if (this.#stderrTail.length > 12) this.#stderrTail.shift();
        this.#log(guessLevel(msg), msg);
      }
    });
    child.on('error', (err) => this.#die(`sweep engine failed: ${err.message}`));
    child.on('exit', (code, signal) => {
      if (this.#child !== child) return;
      this.#child = null;
      this.#die(
        `the sweep engine exited (code ${code ?? 'none'}, signal ${signal ?? 'none'})`
      );
    });
  }

  #onConnection(socket) {
    if (this.#conn) {
      socket.destroy();
      return;
    }
    this.#conn = socket;
    socket.unref?.();
    const reassembler = new FrameReassembler((raw) => this.#onFrame(raw));
    socket.on('data', (chunk) => {
      try {
        reassembler.push(chunk);
      } catch (err) {
        this.#die(`the sweep engine's frame stream went bad: ${err.message}`);
      }
    });
    socket.on('error', (err) => this.#log('warn', `engine socket: ${err.message}`));
    socket.on('close', () => {
      if (this.#conn !== socket) return;
      this.#conn = null;
      // A dying engine drops the socket a moment before its exit is reported.
      // Waiting for that gives the user the exit code and the last thing the
      // engine said, instead of "the connection closed".
      const timer = setTimeout(
        () => this.#die('the sweep engine closed its connection'),
        150
      );
      timer.unref?.();
    });
  }

  #onFrame(raw) {
    let frame;
    try {
      frame = decodeFrame(raw);
    } catch (err) {
      this.#log('warn', `undecodable engine frame: ${err.message}`);
      return;
    }
    switch (frame.msgType) {
      case MsgType.TraceComplete:
        this.onSweep?.(frame);
        break;
      case MsgType.TracePartial:
        // A partial sweep drawn as if it were whole is a cliff on the plot.
        break;
      case MsgType.Status: {
        const type = frame.json?.type;
        if (type === 'status') {
          this.status = frame.json;
          this.#armHealthTimer();
          this.#onReady?.(frame.json);
        } else if (type === 'applied') {
          const waiter = this.#applyWaiters.shift();
          waiter?.done();
          waiter?.resolve(frame.json);
        }
        break;
      }
      case MsgType.Log:
        this.#log(frame.json?.level ?? 'info', frame.json?.msg ?? '');
        break;
      default:
        break;
    }
  }

  #armHealthTimer() {
    this.#clearHealthTimer();
    this.#healthTimer = setTimeout(() => {
      this.#healthTimer = null;
      this.#die(
        `the sweep engine stopped answering for ${HEALTH_TIMEOUT_MS / 1000}s; the USRP may have been unplugged`
      );
    }, HEALTH_TIMEOUT_MS);
    this.#healthTimer.unref?.();
  }

  #clearHealthTimer() {
    if (this.#healthTimer) clearTimeout(this.#healthTimer);
    this.#healthTimer = null;
  }

  /** One-way door: report the death once, kill whatever is left, stay alive. */
  #die(reason) {
    if (this.#stopping || this.#dead) return;
    this.#dead = true;
    this.#clearHealthTimer();
    const child = this.#child;
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }
    for (const waiter of this.#applyWaiters.splice(0)) {
      waiter.done?.();
      waiter.reject(new EngineError(reason));
    }
    if (this.#onEarlyExit) {
      this.#onEarlyExit(reason);
      return;
    }
    this.onFatal?.(new EngineError(`${reason}. ${this.#tail()}`.trimEnd()));
  }

  #tail() {
    const lines = this.#stderrTail.filter(
      (l) => !l.startsWith('[INFO]') || /error|fail/i.test(l)
    );
    const last = lines.slice(-3);
    return last.length ? `Engine said: ${last.join(' / ')}` : '';
  }

  #log(level, msg) {
    this.onLog?.({ level, msg });
  }
}

function guessLevel(line) {
  if (/\b(error|fatal|exception|refus)/i.test(line)) return 'error';
  if (/\b(warn|warning|overflow|timeout)\b/i.test(line)) return 'warn';
  return 'info';
}
