import { AsyncLocalStorage } from "node:async_hooks";

import type { SupportedProtocol } from "./plugins.js";

/** Privacy-protocol sync, or ERC-5564 stealth announcement scan. */
export type SyncProgressSource = SupportedProtocol | "stealth";

export type SyncProgressPhase = "saga" | "rpc" | "subsquid" | "asp" | "sync";

export type SyncProgressUpdate = {
  phase?: SyncProgressPhase;
  done?: number;
  total?: number;
  detail?: string;
};

type SyncProgressStore = {
  protocol: SyncProgressSource;
  started: number;
  onUpdate?: (message: string) => void;
  phase: SyncProgressPhase;
  done?: number;
  total?: number;
  detail?: string;
  httpCounts: Partial<Record<"saga" | "subsquid" | "asp", number>>;
  lastEmit: number;
  lastMessage: string;
  emitTimer?: ReturnType<typeof setTimeout>;
};

const als = new AsyncLocalStorage<SyncProgressStore>();

const PROTOCOL_LABEL: Record<SyncProgressSource, string> = {
  railgun: "Railgun",
  "privacy-pools": "Privacy Pools",
  tornado: "Tornado Cash",
  stealth: "Stealth",
};

const PHASE_NOUN: Record<SyncProgressPhase, string> = {
  saga: "saga req",
  rpc: "RPC logs",
  subsquid: "Subsquid",
  asp: "ASP",
  sync: "sync",
};

const COALESCE_MS = 250;
const TICK_MS = 5_000;
const SLOW_HINT_MS = 8_000;

function formatElapsed(ms: number): string {
  const secs = Math.max(0, Math.round(ms / 1000));
  if (secs < 60) return `${secs}s`;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}m ${s.toString().padStart(2, "0")}s`;
}

function asciiBar(done: number, total: number, width = 14): string {
  const pct = Math.min(1, Math.max(0, done / total));
  const filled = Math.round(pct * width);
  if (filled >= width) return `[${"=".repeat(width)}]`;
  if (filled <= 0) return `[${" ".repeat(width)}]`;
  return `[${"=".repeat(filled - 1)}>${" ".repeat(width - filled)}]`;
}

function slowHint(store: SyncProgressStore, hasBar: boolean): string {
  if (hasBar) return "";
  if (Date.now() - store.started < SLOW_HINT_MS) return "";
  return " · first run can take several minutes";
}

function formatMessage(store: SyncProgressStore): string {
  const elapsed = formatElapsed(Date.now() - store.started);
  const name = PROTOCOL_LABEL[store.protocol];
  const hasBar =
    store.total != null && store.total > 0 && store.done != null;
  const slow = slowHint(store, hasBar);

  if (hasBar) {
    const bar = asciiBar(store.done!, store.total!);
    const verb = store.protocol === "stealth" ? "scan" : "first sync";
    const noun =
      store.protocol === "stealth"
        ? "announcement chunks"
        : store.phase === "subsquid"
          ? "Subsquid req"
          : PHASE_NOUN[store.phase];
    return `${name} ${verb}  ${bar} ${store.done}/${store.total} ${noun}  ${elapsed}${slow}`;
  }

  const count = store.httpCounts[store.phase as "saga" | "subsquid" | "asp"];
  const req = count ? ` · ${count} req` : "";

  if (store.phase === "subsquid") {
    return `${name} sync · Subsquid over Tor${req} · ${elapsed}${slow}`;
  }
  if (store.phase === "asp") {
    return `${name} sync · ASP${req} · ${elapsed}${slow}`;
  }
  if (store.phase === "saga") {
    return `${name} sync · saga CDN${req} · ${elapsed}${slow}`;
  }
  if (store.detail) {
    return `${name} ${store.protocol === "stealth" ? "scan" : "sync"} · ${store.detail} · ${elapsed}${slow}`;
  }
  return `${name} ${store.protocol === "stealth" ? "scan" : "sync"} · ${elapsed}${slow}`;
}

function flush(store: SyncProgressStore, force = false): void {
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

/** Report determinate sync progress (saga requests, RPC log windows). */
export function reportSyncProgress(update: SyncProgressUpdate): void {
  const store = als.getStore();
  if (!store) return;
  if (update.phase) store.phase = update.phase;
  if (update.done != null) store.done = update.done;
  if (update.total != null) store.total = update.total;
  if (update.detail != null) store.detail = update.detail;
  flush(store);
}

/**
 * Count categorized HTTP (Subsquid / ASP / saga) so protocols without a
 * chunk iterator still show activity. Subsquid and saga keep a determinate
 * `done/total` bar (total is primed from index / GraphQL counts, then grows
 * if we issue more requests). Does not replace an RPC catch-up bar.
 */
export function reportSyncHttp(category: "saga" | "subsquid" | "asp"): void {
  const store = als.getStore();
  if (!store) return;
  store.httpCounts[category] = (store.httpCounts[category] ?? 0) + 1;

  if (
    store.phase === "rpc" &&
    store.total != null &&
    store.total > 0
  ) {
    flush(store);
    return;
  }

  if (category === "subsquid" || category === "saga") {
    store.phase = category;
    const done = store.httpCounts[category] ?? 0;
    store.done = done;
    if (store.total == null || store.total <= done) {
      store.total = done + 1;
    }
    flush(store);
    return;
  }

  store.phase = category;
  store.done = undefined;
  store.total = undefined;
  flush(store);
}

export async function runWithSyncProgress<T>(
  opts: {
    protocol: SyncProgressSource;
    onUpdate?: (message: string) => void;
  },
  fn: () => Promise<T>
): Promise<T> {
  const existing = als.getStore();
  if (existing) {
    return fn();
  }

  const store: SyncProgressStore = {
    protocol: opts.protocol,
    started: Date.now(),
    onUpdate: opts.onUpdate,
    phase: "sync",
    httpCounts: {},
    lastEmit: 0,
    lastMessage: "",
  };

  const tick = opts.onUpdate
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
  }
}

/**
 * Explicit `plugin.sync()` for Tornado / Privacy Pools (no-op for Railgun).
 * Safe to call inside or outside {@link runWithSyncProgress}.
 */
export async function syncPluginWithProgress(
  plugin: { sync?: () => Promise<void> },
  protocol: SupportedProtocol,
  onUpdate?: (message: string) => void
): Promise<void> {
  if (protocol !== "privacy-pools" && protocol !== "tornado") return;
  if (typeof plugin.sync !== "function") return;
  await runWithSyncProgress({ protocol, onUpdate }, () =>
    plugin.sync!.call(plugin)
  );
}
