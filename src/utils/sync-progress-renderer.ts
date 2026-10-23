import { writeSync } from "node:fs";
import { Worker } from "node:worker_threads";

import { takeTerminal } from "./progress-terminal.js";

/** Cursor to column 0 + erase below, the same reset clack uses. */
const CLEAR_LINE = "\u001b[999D\u001b[J";
const HIDE_CURSOR = "\u001b[?25l";

export type ProgressSnapshot = {
  /** Source line, without the elapsed clock. The worker appends that. */
  header: string;
  firstRun: boolean;
  activity?: string;
  rows: Array<{ label: string; done: number; total: number; suffix: string;
    startedAt?: number; updatedAt?: number; samples?: number; unit?: string }>;
};

/** Shared by the worker and the fallback; estimates apply only to this task. */
export function formatProgressMetrics(row: ProgressSnapshot["rows"][number], now: number): string {
  if (row.done >= row.total) return "task complete";
  const percent = Math.floor(100 * row.done / row.total);
  const age = now - (row.startedAt ?? now);
  if (age < 3000 || (row.samples ?? 0) < 3 || row.done <= 0) {
    return `${percent}% · estimating speed / ETA`;
  }
  const rate = row.done / (age / 1000);
  const remaining = Math.ceil((row.total - row.done) / rate);
  const duration = remaining < 60 ? `${remaining}s` : remaining < 3600
    ? `${Math.ceil(remaining / 60)}m` : `${(remaining / 3600).toFixed(1)}h`;
  const speed = rate >= 10 ? Math.round(rate).toLocaleString("en-US") : rate.toFixed(1);
  // Once updates stop, keep reporting throughput but stop extrapolating an ETA.
  const eta = now - (row.updatedAt ?? now) > 15000 ? "ETA unavailable (waiting)" : `task ETA ~${duration}`;
  return `${percent}% · ${speed} ${row.unit ?? "units"}/s · ${eta}`;
}

/** Return to the top of the current block, even after the terminal scrolls. */
export function clearProgressBlock(height: number): string {
  return "\r" + (height > 1 ? `\u001b[${height - 1}A` : "") + "\u001b[J";
}

/** Keep every output line on one physical row and the block inside the viewport. */
export function layoutProgressBlock(lines: string[], columns: number, rows: number): string[] {
  const width = Math.max(1, columns - 1); // Avoid the terminal's pending autowrap state.
  const height = Math.max(1, rows - 1);
  const clipped = lines.slice(0, height).map((line) => {
    // All generated labels use single-column glyphs (English, hex, bars, ellipsis).
    const chars = Array.from(line);
    return chars.length <= width ? line : chars.slice(0, width - 1).join("") + "…";
  });
  if (lines.length > height && height > 1) {
    clipped[height - 1] = `   +${lines.length - height + 1} more lines`.slice(0, width);
  }
  return clipped;
}

/**
 * Draws the sync status block from a worker thread.
 *
 * Protocol syncs spend long stretches inside synchronous WASM. Nothing on the
 * main thread can animate through that, so the elapsed clock is drawn here.
 * `done` stays at the last value the main thread posted. A quiet stretch adds
 * "still working" to the header instead of inventing another step.
 *
 * The worker writes the fd directly: a worker's `process.stdout` is piped
 * through the parent thread, so those writes would queue up behind the block.
 */
const DOT = " · ";
const FULL = "\u2588";
const EMPTY = "\u2591";
const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
const { writeSync } = require('node:fs');

const FRAMES = ['\u25D2', '\u25D0', '\u25D3', '\u25D1'];
const clearBlock = ${clearProgressBlock.toString()};
const layoutBlock = ${layoutProgressBlock.toString()};
const state = new Int32Array(workerData.state);
let columns = workerData.columns;
let rows = workerData.rows;
let renderedLines = [];
const DOT = ${JSON.stringify(DOT)};
const FULL = ${JSON.stringify(FULL)};
const EMPTY = ${JSON.stringify(EMPTY)};
const NL = ${JSON.stringify("\r\n")};
const STALE_MS = 2000;
const SLOW_HINT_MS = 8000;
const BAR_WIDTH = 16;
const metrics = ${formatProgressMetrics.toString()};

let snapshot = workerData.snapshot;
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

function bar(done, total) {
  const filled =
    total <= 0 ? 0 : Math.max(0, Math.min(BAR_WIDTH, Math.floor((done / total) * BAR_WIDTH)));
  return FULL.repeat(filled) + EMPTY.repeat(BAR_WIDTH - filled);
}

function render() {
  // stop() waits for this lock before clearing and returning the line to clack.
  if (Atomics.compareExchange(state, 1, 0, 1) !== 0) return;
  try {
    if (Atomics.load(state, 0)) return;
    draw();
  } finally {
    Atomics.store(state, 1, 0);
    Atomics.notify(state, 1);
  }
}

function draw() {
  const glyph = FRAMES[frame++ % FRAMES.length];
  let header = glyph + '  ' + snapshot.header + DOT + elapsed();
  if (Date.now() - lastUpdate > STALE_MS) {
    header += DOT + 'still working';
  }
  if (snapshot.firstRun && Date.now() - startedAt >= SLOW_HINT_MS) {
    header += DOT + 'first run can take several minutes';
  }
  if (snapshot.activity) header += DOT + snapshot.activity;
  const lines = [header];
  const visible = snapshot.rows.slice(0, 4);
  for (const row of visible) {
    const detail = metrics(row, Date.now());
    const title = '   ' + row.label;
    if (title.length + DOT.length + detail.length < columns) {
      lines.push(title + DOT + detail);
    } else {
      lines.push(title);
      lines.push('   ' + detail);
    }
    lines.push('   [' + bar(row.done, row.total) + ']  ' + row.suffix);
  }
  if (snapshot.rows.length > visible.length) {
    lines.push('   +' + (snapshot.rows.length - visible.length) + ' other tasks');
  }
  const block = layoutBlock(lines, columns, rows);
  const previousHeight = Atomics.load(state, 2);
  write(clearBlock(previousHeight) + block.join(NL));
  renderedLines = block;
  Atomics.store(state, 2, block.length);
}

const timer = setInterval(render, 120);
render();

parentPort.on('message', (msg) => {
  if (msg && msg.type === 'state') {
    snapshot = msg.snapshot;
    lastUpdate = Date.now();
  } else if (msg && msg.type === 'resize') {
    columns = msg.columns;
    rows = msg.rows;
    // A narrower terminal can reflow the previous frame before our next draw.
    const reflowedHeight = renderedLines.reduce((height, line) =>
      height + Math.max(1, Math.ceil(Array.from(line).length / Math.max(1, columns))), 0);
    Atomics.store(state, 2, reflowedHeight);
  }
});
`;

export type ProgressRenderer = {
  update(snapshot: ProgressSnapshot): void;
  stop(): void;
};

function disabled(): boolean {
  const raw = process.env.KOHAKU_NO_WORKER_PROGRESS?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

/**
 * Takes over the terminal and animates the sync block from a worker thread.
 *
 * Returns `null` when worker rendering is unavailable or nothing owns the line,
 * in which case the caller falls back to emitting a one-line summary.
 */
export function startProgressRenderer(
  snapshot: ProgressSnapshot,
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

  // Shared stop flag, draw lock, and physical row count. The parent must be able
  // to clear the block even while its own event loop has been blocked by WASM.
  const sharedState = new SharedArrayBuffer(3 * Int32Array.BYTES_PER_ELEMENT);
  const state = new Int32Array(sharedState);
  const dimensions = () => ({ columns: process.stdout.columns || 80, rows: process.stdout.rows || 24 });
  let worker: Worker;
  try {
    writeSync(1, HIDE_CURSOR);
    worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { snapshot, startedAt, state: sharedState, ...dimensions() },
      stdout: true,
      stderr: true,
    });
  } catch {
    try {
      writeSync(1, CLEAR_LINE);
    } catch {
      // ignore
    }
    restoreTerminal();
    return null;
  }
  // Never hold the process open or surface a render failure as a sync failure.
  worker.unref();
  worker.on("error", () => {});

  let stopped = false;
  const onResize = () => {
    if (stopped) return;
    try {
      worker.postMessage({ type: "resize", ...dimensions() });
    } catch {
      // Match update(): terminal resizing must never interrupt a sync.
    }
  };
  process.stdout.on("resize", onResize);

  return {
    update(next: ProgressSnapshot) {
      if (stopped) return;
      try {
        worker.postMessage({ type: "state", snapshot: next });
      } catch {
        // Worker already gone; the block just stops updating.
      }
    },
    stop() {
      if (stopped) return;
      stopped = true;
      process.stdout.off("resize", onResize);
      // terminate() is asynchronous. Stop new draws and let any in-flight write
      // finish before clearing, so it cannot print over the resumed spinner.
      Atomics.store(state, 0, 1);
      Atomics.wait(state, 1, 1, 1000);
      void worker.terminate();
      try {
        writeSync(1, clearProgressBlock(Atomics.load(state, 2)));
      } catch {
        // ignore
      }
      restoreTerminal();
    },
  };
}
