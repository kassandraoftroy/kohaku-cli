import { writeSync } from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";

import type { SupportedProtocol } from "./plugins.js";
import {
  startProgressRenderer,
  formatProgressMetrics,
  type ProgressRenderer,
  type ProgressSnapshot,
} from "./sync-progress-renderer.js";

/** Privacy-protocol sync, or ERC-5564 stealth announcement scan. */
export type SyncProgressSource = SupportedProtocol | "stealth";

/** A step whose size is known: saga chunks or RPC windows. */
export type DeterminateSyncKind = "saga" | "rpc";

type DeterminateUnit = "chunks" | "windows" | "blocks";

type DeterminateRow = {
  id: number;
  kind: DeterminateSyncKind;
  unit: DeterminateUnit;
  total: number;
  done: number;
  label?: string;
  key?: string;
  pass?: number;
  started: number;
  updated: number;
  samples: number;
  range?: { from: bigint; to: bigint; covered: Array<[bigint, bigint]> };
};

type SyncProgressStore = {
  source: SyncProgressSource;
  activities: Map<symbol, string>;
  rpcHead?: bigint;
  firstRun: boolean;
  started: number;
  /** Last time the fraction or the label changed. The idle hint reads this. */
  lastActivity: number;
  onUpdate?: (message: string) => void;
  rows: DeterminateRow[];
  nextId: number;
  closed: boolean;
  lastEmit: number;
  lastMessage: string;
  lastSnapshotKey?: string;
  emitTimer?: ReturnType<typeof setTimeout>;
  /** Owns the status block when set; it renders the elapsed clock itself. */
  renderer?: ProgressRenderer;
};

/**
 * The live sync. Tornado's state manager runs in a worker and calls back
 * through Comlink, which is outside {@link runWithSyncProgress}'s async
 * context, so ticks read this instead of async-local storage.
 */
let currentSession: SyncProgressStore | null = null;

const als = new AsyncLocalStorage<SyncProgressStore>();

const SOURCE_LABEL: Record<SyncProgressSource, string> = {
  railgun: "Railgun",
  "privacy-pools": "Privacy Pools",
  tornado: "Tornado Cash",
  stealth: "Stealth",
};

const COALESCE_MS = 250;
/**
 * Redraw at least once a second so the elapsed counter visibly advances during
 * long stretches with no progress events, when the worker renderer is unavailable.
 */
const TICK_MS = 1_000;
const STALE_MS = 2_000;
const SLOW_HINT_MS = 8_000;

const NO_TICKET: SyncUnitTicket = { advance() {} };

export type SyncUnitTicket = {
  /** Mark `by` units done (default 1). Never decreases, never passes the total. */
  advance(by?: number): void;
};

function formatElapsed(ms: number): string {
  const secs = Math.max(0, Math.round(ms / 1000));
  if (secs < 60) return `${secs}s`;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}m ${s.toString().padStart(2, "0")}s`;
}

function sourceHeader(store: SyncProgressStore): string {
  const name = SOURCE_LABEL[store.source];
  const verb = store.source === "stealth" ? "scan" : "sync";
  return store.firstRun ? `${name} first ${verb}` : `${name} ${verb}`;
}

function stepLabel(kind: DeterminateSyncKind, summary: boolean): string {
  if (kind === "saga") return summary ? "Saga" : "Saga sync";
  return summary ? "RPC" : "RPC sync";
}

function visibleRows(store: SyncProgressStore): DeterminateRow[] {
  // Keep the display focused on current work. Retaining a completed pool/pass
  // beside its next pass makes the same stream appear to run twice.
  const active = store.rows.filter((row) => !rowComplete(row));
  if (active.length > 0) return active;
  const last = store.rows.filter(rowComplete).at(-1);
  return last ? [last] : [];
}

function rowLabel(row: DeterminateRow, summary = false): string {
  const label = row.label ?? (row.unit === "blocks" ? "Blocks" : stepLabel(row.kind, summary));
  return row.pass && row.pass > 1 ? `${label} (pass ${row.pass})` : label;
}

function summaryParts(store: SyncProgressStore): string[] {
  return visibleRows(store).map((row) => {
    const metrics = formatProgressMetrics({
      label: rowLabel(row), suffix: "", done: row.done, total: row.total,
      startedAt: row.started, updatedAt: row.updated, samples: row.samples, unit: row.unit,
    }, Date.now());
    return `${rowLabel(row, true)} ${row.done}/${row.total} ${row.unit} · ${metrics}`;
  });
}

/** One line for a non-TTY sink or the spinner that resumes after the worker. */
function formatSummary(store: SyncProgressStore, includeStale = false): string {
  const parts = summaryParts(store);
  const body = parts.length > 0 ? parts.join(" · ") : "starting";
  const processing = store.activities.size ? ` · ${[...store.activities.values()].at(-1)}` : allComplete(store) ? " · processing / discovering next task" : "";
  const stale =
    includeStale && Date.now() - store.lastActivity >= STALE_MS ? " · still working" : "";
  const slow =
    store.firstRun && Date.now() - store.started >= SLOW_HINT_MS
      ? " · first run can take several minutes"
      : "";
  return `${sourceHeader(store)} · ${body}${processing} · ${formatElapsed(Date.now() - store.started)}${stale}${slow}`;
}

function buildSnapshot(store: SyncProgressStore): ProgressSnapshot {
  const rows: ProgressSnapshot["rows"] = [];
  for (const row of visibleRows(store)) {
    if (row.total <= 0) continue;
    rows.push({
      label: rowLabel(row),
      startedAt: row.started,
      updatedAt: row.updated,
      samples: row.samples,
      unit: row.unit,
      done: row.done,
      total: row.total,
      suffix: `${row.done}/${row.total} ${row.unit}`,
    });
  }
  return { header: sourceHeader(store), firstRun: store.firstRun, rows,
    activity: [...store.activities.values()].at(-1) ?? (allComplete(store) ? "processing / discovering next task" : undefined) };
}

function flush(store: SyncProgressStore, force = false, includeStale = false): void {
  if (store.closed) return;
  if (store.renderer) {
    const snapshot = buildSnapshot(store);
    const key = JSON.stringify(snapshot);
    if (key === store.lastSnapshotKey) return;
    store.lastSnapshotKey = key;
    store.renderer.update(snapshot);
    return;
  }
  if (!store.onUpdate) return;
  const now = Date.now();
  if (!force && now - store.lastEmit < COALESCE_MS) {
    if (!store.emitTimer) {
      store.emitTimer = setTimeout(() => {
        store.emitTimer = undefined;
        flush(store, true, includeStale);
      }, COALESCE_MS - (now - store.lastEmit));
    }
    return;
  }
  if (store.emitTimer) {
    clearTimeout(store.emitTimer);
    store.emitTimer = undefined;
  }
  const msg = formatSummary(store, includeStale);
  if (msg === store.lastMessage) return;
  store.lastMessage = msg;
  store.lastEmit = now;
  store.onUpdate(msg);
}

function touch(store: SyncProgressStore): void {
  store.lastActivity = Date.now();
}

function rowComplete(row: DeterminateRow): boolean {
  return row.total > 0 && row.done >= row.total;
}

function allComplete(store: SyncProgressStore): boolean {
  return store.rows.length > 0 && store.rows.every(rowComplete);
}

function findRow(
  store: SyncProgressStore,
  kind: DeterminateSyncKind,
  unit: DeterminateUnit
): DeterminateRow | undefined {
  return store.rows.find((row) => row.kind === kind && row.unit === unit);
}

/** Register one task with a fixed total, independent of other pools/streams. */
export function addSyncUnits(kind: DeterminateSyncKind, units: number, label?: string): SyncUnitTicket {
  const store = currentSession;
  if (!store || store.closed || !Number.isFinite(units) || units < 1) return NO_TICKET;
  const row: DeterminateRow = {
    id: store.nextId++, kind, unit: kind === "saga" ? "chunks" : "windows",
    total: Math.floor(units), done: 0, label,
    pass: label ? store.rows.filter((r) => r.label === label).length + 1 : undefined,
    started: Date.now(), updated: Date.now(), samples: 0,
  };
  store.rows.push(row);
  touch(store);
  flush(store);
  return {
    advance(by = 1) {
      if (store.closed || !Number.isFinite(by) || by <= 0) return;
      const next = Math.min(row.total, row.done + Math.floor(by));
      if (next === row.done) return;
      row.done = next;
      row.updated = Date.now();
      row.samples++;
      touch(store);
      flush(store);
    },
  };
}

/** Whether the active sync still needs a target for SDK-batched log scans. */
export function needsSyncHead(): boolean {
  return !!currentSession && !currentSession.closed && currentSession.rpcHead === undefined;
}

/** Freeze the observed head for this sync session, not for the provider lifetime. */
export function noteSyncHead(head: bigint): void {
  const store = currentSession;
  if (store && !store.closed && store.rpcHead === undefined) store.rpcHead = head;
}

/**
 * SDKs issue their own small batches before host chunking. Track covered block
 * intervals per address + topic across those calls, all the way to the observed
 * head. Count neither overlapping boundary blocks nor retries twice.
 * `toHead` is only enabled on protocol hosts whose sync scans target the head.
 */
export function addRpcSyncRange(
  key: string, label: string, from: bigint, to: bigint, toHead = false
): { complete(from: bigint, to: bigint): void } {
  const store = currentSession;
  if (!store || store.closed || from > to) return { complete() {} };
  const target = toHead && store.rpcHead !== undefined && store.rpcHead > to
    ? store.rpcHead : to;
  let row = store.rows.find((r) => r.range && r.label === label && r.key === key &&
    !rowComplete(r) && from >= r.range.from && from <= r.range.to);
  // The SDK may read a newer head between batches. Its final request can
  // straddle our frozen target; keep it on this task and clamp coverage to the
  // original range rather than orphaning a nearly-complete bar. Completion is
  // still reported only after the request succeeds.
  if (!row) {
    row = {
      id: store.nextId++, kind: "rpc", unit: "blocks", key, label,
      pass: store.rows.filter((r) => r.key === key).length + 1,
      total: Number(target - from + 1n), done: 0,
      started: Date.now(), updated: Date.now(), samples: 0,
      range: { from, to: target, covered: [] },
    };
    store.rows.push(row);
    touch(store);
    flush(store);
  }
  const task = row;
  return { complete(start, end) {
    if (store.closed || !task.range) return;
    const range = task.range;
    start = start < range.from ? range.from : start;
    end = end > range.to ? range.to : end;
    if (start > end) return;
    const intervals = [...range.covered, [start, end] as [bigint, bigint]]
      .sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
    const merged: Array<[bigint, bigint]> = [];
    for (const interval of intervals) {
      const last = merged.at(-1);
      if (last && interval[0] <= last[1] + 1n) {
        if (interval[1] > last[1]) last[1] = interval[1];
      } else merged.push([...interval]);
    }
    range.covered = merged;
    const done = Number(merged.reduce((sum, [a, b]) => sum + b - a + 1n, 0n));
    if (done === task.done) return;
    task.done = done;
    task.updated = Date.now();
    task.samples++;
    touch(store);
    flush(store);
  } };
}

/** Activity without a measurable total must not pretend to be a progress bar. */
export function beginSyncActivity(activity: string): () => void {
  const store = currentSession;
  if (!store || store.closed) return () => {};
  const token = Symbol();
  store.activities.set(token, activity);
  touch(store);
  flush(store);
  return () => {
    if (store.closed) return;
    store.activities.delete(token);
    touch(store);
    flush(store);
  };
}

/**
 * Refine the first-run label from inside the scope, for sources that only learn
 * it after opening their own storage (the stealth scan).
 */
export function noteSyncFirstRun(firstRun: boolean): void {
  const store = currentSession;
  if (!store || store.closed || store.firstRun === firstRun) return;
  store.firstRun = firstRun;
  touch(store);
  flush(store);
}

/**
 * Inclusive stealth scan window (`scanned/total` blocks). The total is fixed
 * on the first call and is not rewritten. `done` never moves backward.
 */
export function reportSyncBlockProgress(scanned: bigint, total: bigint): void {
  const store = currentSession;
  if (!store || store.closed || total <= 0n) return;

  let row = findRow(store, "rpc", "blocks");
  const created = !row;
  if (!row) {
    if (allComplete(store)) store.rows = [];
    const fixed = Number(total);
    row = {
      id: store.nextId++,
      kind: "rpc",
      unit: "blocks",
      total: fixed,
      done: 0,
      started: Date.now(), updated: Date.now(), samples: 0,
    };
    store.rows.push(row);
  }
  const next = Math.min(row.total, Math.max(row.done, Number(scanned)));
  if (!created && next === row.done) return;
  row.done = next;
  row.updated = Date.now();
  row.samples++;
  touch(store);
  flush(store);
}

export async function runWithSyncProgress<T>(
  opts: {
    source: SyncProgressSource;
    firstRun?: boolean;
    onUpdate?: (message: string) => void;
    /**
     * Durable line written after taking the terminal and before the progress
     * block. TTY-only (the worker renderer); callers should print it themselves
     * when stdout is not a TTY.
     */
    prelude?: string;
  },
  fn: () => Promise<T>
): Promise<T> {
  if (als.getStore()) {
    return fn();
  }

  const started = Date.now();
  const store: SyncProgressStore = {
    source: opts.source,
    firstRun: opts.firstRun ?? false,
    started,
    lastActivity: started,
    onUpdate: opts.onUpdate,
    rows: [],
    activities: new Map(),
    nextId: 1,
    closed: false,
    lastEmit: 0,
    lastMessage: "",
  };

  // A worker keeps drawing through the long synchronous WASM stretches that
  // make up most of a sync; the main-thread tick cannot. `onUpdate` being unset
  // means quiet mode, where nothing may touch the terminal.
  if (opts.onUpdate) {
    const snapshot = buildSnapshot(store);
    store.renderer = startProgressRenderer(snapshot, store.started, opts.prelude) ?? undefined;
    if (store.renderer) store.lastSnapshotKey = JSON.stringify(snapshot);
    else if (opts.prelude && process.stdout.isTTY) {
      // Worker renderer unavailable (e.g. KOHAKU_NO_WORKER_PROGRESS): still
      // persist the range line after the spinner has the line.
      try {
        writeSync(1, opts.prelude.endsWith("\n") ? opts.prelude : `${opts.prelude}\n`);
      } catch {
        // ignore
      }
    }
  }

  const tick =
    opts.onUpdate && !store.renderer
      ? setInterval(() => flush(store, true, true), TICK_MS)
      : undefined;

  currentSession = store;
  try {
    return await als.run(store, async () => {
      flush(store, true);
      return fn();
    });
  } finally {
    currentSession = null;
    if (tick) clearInterval(tick);
    if (store.emitTimer) {
      clearTimeout(store.emitTimer);
      store.emitTimer = undefined;
    }
    if (store.renderer) {
      store.renderer.stop();
      store.renderer = undefined;
      // Hand the final line back to the caller's spinner.
      opts.onUpdate?.(formatSummary(store));
    } else {
      flush(store, true);
    }
    store.closed = true;
  }
}

/**
 * Explicit `plugin.sync()` when the plugin has one (no-op for Railgun).
 * Safe to call inside or outside {@link runWithSyncProgress}.
 */
export async function syncPluginWithProgress(
  plugin: { sync?: () => Promise<void> },
  protocol: SupportedProtocol,
  opts: {
    firstRun?: boolean;
    onUpdate?: (message: string) => void;
  } = {}
): Promise<void> {
  if (typeof plugin.sync !== "function") return;
  await runWithSyncProgress(
    { source: protocol, firstRun: opts.firstRun, onUpdate: opts.onUpdate },
    () => plugin.sync!.call(plugin)
  );
}
