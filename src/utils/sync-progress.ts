import { AsyncLocalStorage } from "node:async_hooks";

import type { SupportedProtocol } from "./plugins.js";
import {
  startProgressRenderer,
  type ProgressRenderer,
} from "./sync-progress-renderer.js";

/** Privacy-protocol sync, or ERC-5564 stealth announcement scan. */
export type SyncProgressSource = SupportedProtocol | "stealth";

/** Where the current sync work is happening. */
export type SyncProgressPhase = "rpc" | "subsquid" | "saga" | "asp";

type SyncProgressStore = {
  source: SyncProgressSource;
  firstRun: boolean;
  started: number;
  onUpdate?: (message: string) => void;
  phase?: SyncProgressPhase;
  counts: Partial<Record<SyncProgressPhase, number>>;
  lastEmit: number;
  lastMessage: string;
  emitTimer?: ReturnType<typeof setTimeout>;
  /** Owns the status line when set; it renders the elapsed clock itself. */
  renderer?: ProgressRenderer;
  lastPrefix?: string;
};

const als = new AsyncLocalStorage<SyncProgressStore>();

const SOURCE_LABEL: Record<SyncProgressSource, string> = {
  railgun: "Railgun",
  "privacy-pools": "Privacy Pools",
  tornado: "Tornado Cash",
  stealth: "Stealth",
};

const PHASE_LABEL: Record<SyncProgressPhase, string> = {
  rpc: "RPC logs",
  subsquid: "Subsquid over Tor",
  saga: "saga CDN",
  asp: "ASP",
};

const COALESCE_MS = 250;
/**
 * Redraw at least once a second so the elapsed counter visibly advances during
 * long stretches with no progress events (cached pages feeding CPU-bound WASM).
 */
const TICK_MS = 1_000;
const SLOW_HINT_MS = 8_000;

function formatElapsed(ms: number): string {
  const secs = Math.max(0, Math.round(ms / 1000));
  if (secs < 60) return `${secs}s`;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}m ${s.toString().padStart(2, "0")}s`;
}

/** Everything before the elapsed time, which the renderer appends itself. */
function formatPrefix(store: SyncProgressStore): string {
  const name = SOURCE_LABEL[store.source];
  const verb = store.source === "stealth" ? "scan" : "sync";
  const label = store.firstRun ? `${name} first ${verb}` : `${name} ${verb}`;
  const phase = store.phase ? PHASE_LABEL[store.phase] : "starting";
  const count = store.phase ? store.counts[store.phase] : undefined;
  return `${label} · ${phase}${count ? ` · ${count} req` : ""}`;
}

function formatMessage(store: SyncProgressStore): string {
  const slow =
    store.firstRun && Date.now() - store.started >= SLOW_HINT_MS
      ? " · first run can take several minutes"
      : "";
  return `${formatPrefix(store)} · ${formatElapsed(Date.now() - store.started)}${slow}`;
}

function flush(store: SyncProgressStore, force = false): void {
  if (store.renderer) {
    const prefix = formatPrefix(store);
    if (prefix === store.lastPrefix) return;
    store.lastPrefix = prefix;
    store.renderer.update(prefix);
    return;
  }
  if (!store.onUpdate) return;
  const now = Date.now();
  if (!force && now - store.lastEmit < COALESCE_MS) {
    if (!store.emitTimer) {
      store.emitTimer = setTimeout(() => {
        store.emitTimer = undefined;
        flush(store, true);
      }, COALESCE_MS - (now - store.lastEmit));
    }
    return;
  }
  if (store.emitTimer) {
    clearTimeout(store.emitTimer);
    store.emitTimer = undefined;
  }
  const msg = formatMessage(store);
  if (msg === store.lastMessage) return;
  store.lastMessage = msg;
  store.lastEmit = now;
  store.onUpdate(msg);
}

/** Switch the reported phase without counting a request. */
export function reportSyncPhase(phase: SyncProgressPhase): void {
  const store = als.getStore();
  if (!store) return;
  store.phase = phase;
  flush(store);
}

/**
 * Count one request against `phase` and make it the reported phase. The count
 * is a liveness signal only: there is no denominator, so it never stalls at a
 * wrong total or counts backwards.
 */
export function countSyncRequest(phase: SyncProgressPhase): void {
  const store = als.getStore();
  if (!store) return;
  store.counts[phase] = (store.counts[phase] ?? 0) + 1;
  store.phase = phase;
  flush(store);
}

/**
 * Refine the first-run label from inside the scope, for sources that only learn
 * it after opening their own storage (the stealth scan).
 */
export function noteSyncFirstRun(firstRun: boolean): void {
  const store = als.getStore();
  if (!store) return;
  store.firstRun = firstRun;
  flush(store);
}

export async function runWithSyncProgress<T>(
  opts: {
    source: SyncProgressSource;
    firstRun?: boolean;
    onUpdate?: (message: string) => void;
  },
  fn: () => Promise<T>
): Promise<T> {
  const existing = als.getStore();
  if (existing) {
    return fn();
  }

  const store: SyncProgressStore = {
    source: opts.source,
    firstRun: opts.firstRun ?? false,
    started: Date.now(),
    onUpdate: opts.onUpdate,
    counts: {},
    lastEmit: 0,
    lastMessage: "",
  };

  // A worker keeps drawing through the long synchronous WASM stretches that
  // make up most of a sync; the main-thread tick cannot. `onUpdate` being unset
  // means quiet mode, where nothing may touch the terminal.
  if (opts.onUpdate) {
    const prefix = formatPrefix(store);
    store.renderer = startProgressRenderer(prefix, store.started) ?? undefined;
    if (store.renderer) store.lastPrefix = prefix;
  }

  const tick =
    opts.onUpdate && !store.renderer
      ? setInterval(() => flush(store, true), TICK_MS)
      : undefined;

  try {
    return await als.run(store, async () => {
      flush(store, true);
      return fn();
    });
  } finally {
    if (tick) clearInterval(tick);
    if (store.emitTimer) clearTimeout(store.emitTimer);
    if (store.renderer) {
      store.renderer.stop();
      store.renderer = undefined;
      // Hand the final line back to the caller's spinner.
      opts.onUpdate?.(formatMessage(store));
    }
  }
}

/**
 * Explicit `plugin.sync()` for Tornado / Privacy Pools (no-op for Railgun).
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
  if (protocol !== "privacy-pools" && protocol !== "tornado") return;
  if (typeof plugin.sync !== "function") return;
  await runWithSyncProgress(
    { source: protocol, firstRun: opts.firstRun, onUpdate: opts.onUpdate },
    () => plugin.sync!.call(plugin)
  );
}
