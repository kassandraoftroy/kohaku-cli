import { writeSync } from "node:fs";
import { Worker } from "node:worker_threads";

import { takeTerminal } from "./progress-terminal.js";

/** Cursor to column 0 + erase below, the same reset clack uses. */
const CLEAR_LINE = "\u001b[999D\u001b[J";
const HIDE_CURSOR = "\u001b[?25l";

/**
 * Draws the sync status line from a worker thread.
 *
 * Protocol syncs spend most of their wall time inside synchronous WASM: a real
 * Railgun first sync blocks for ~27s building UTXO trees, then ~65s on txid
 * trees and POI. Nothing on the main thread can animate through that, so the
 * spinner and the elapsed clock freeze and the command looks hung.
 *
 * A worker has its own event loop, so it keeps drawing. It must write to the fd
 * directly: a worker's `process.stdout` is piped through the *parent* thread, so
 * those writes would queue up behind the very block we are drawing through.
 */
const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
const { writeSync } = require('node:fs');

const FRAMES = ['\u25D2', '\u25D0', '\u25D3', '\u25D1'];
const CLEAR = ${JSON.stringify(CLEAR_LINE)};
const STALE_MS = 2000;

let prefix = workerData.prefix;
const startedAt = workerData.startedAt;
let lastUpdate = Date.now();
let frame = 0;

function elapsed() {
  const secs = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
  if (secs < 60) return secs + 's';
  const mins = Math.floor(secs / 60);
  return mins + 'm ' + String(secs % 60).padStart(2, '0') + 's';
}

function write(text) {
  try {
    writeSync(1, text);
  } catch {
    // A closed or busy fd must never take down a sync.
  }
}

function render() {
  // No update for a while means the main thread is busy, not that we are stuck
  // waiting on the network the phase label names.
  const busy = Date.now() - lastUpdate > STALE_MS ? ' \u00b7 still working' : '';
  write(
    CLEAR +
      FRAMES[frame++ % FRAMES.length] +
      '  ' + prefix + ' \u00b7 ' + elapsed() + busy
  );
}

const timer = setInterval(render, 120);
render();

parentPort.on('message', (msg) => {
  if (msg && msg.type === 'state') {
    prefix = msg.prefix;
    lastUpdate = Date.now();
  }
});
`;

export type ProgressRenderer = {
  update(prefix: string): void;
  stop(): void;
};

function disabled(): boolean {
  const raw = process.env.KOHAKU_NO_WORKER_PROGRESS?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

/**
 * Takes over the terminal line and animates it from a worker thread.
 *
 * Returns `null` when worker rendering is unavailable or nothing owns the line,
 * in which case the caller falls back to emitting plain message strings.
 */
export function startProgressRenderer(
  prefix: string,
  startedAt: number,
  prelude?: string
): ProgressRenderer | null {
  if (disabled() || !process.stdout.isTTY) return null;

  // A clack spinner erases everything below its cursor every frame, so it has
  // to stand down before the worker can draw.
  const restoreTerminal = takeTerminal();
  if (!restoreTerminal) return null;

  if (prelude) {
    try {
      writeSync(1, prelude.endsWith("\n") ? prelude : `${prelude}\n`);
    } catch {
      // A closed fd must never take down a sync.
    }
  }

  let worker: Worker;
  try {
    worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { prefix, startedAt },
      stdout: true,
      stderr: true,
    });
  } catch {
    restoreTerminal();
    return null;
  }
  // Never hold the process open or surface a render failure as a sync failure.
  worker.unref();
  worker.on("error", () => {});

  writeSync(1, HIDE_CURSOR);
  let stopped = false;

  return {
    update(next: string) {
      if (stopped) return;
      try {
        worker.postMessage({ type: "state", prefix: next });
      } catch {
        // Worker already gone; the line just stops updating.
      }
    },
    stop() {
      if (stopped) return;
      stopped = true;
      // Terminate before clearing so the worker cannot redraw over the line
      // between our clear and the resumed spinner's first frame.
      void worker.terminate();
      try {
        writeSync(1, CLEAR_LINE);
      } catch {
        // ignore
      }
      restoreTerminal();
    },
  };
}
