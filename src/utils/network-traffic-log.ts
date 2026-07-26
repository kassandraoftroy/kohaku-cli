/**
 * Per-wallet NDJSON network traffic log for anonymity / risk review.
 *
 * Written under `<walletDir>/network-traffic.ndjson`. URLs are redacted so
 * API keys in paths/queries are not persisted (Pimlico and local/loopback RPC
 * URLs are left intact — they are keyless).
 */
import { AsyncLocalStorage } from "node:async_hooks";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

export const NETWORK_TRAFFIC_LOG_FILENAME = "network-traffic.ndjson";

/** Soft cap so the log cannot grow without bound on long-lived wallets. */
const MAX_LOG_BYTES = 8 * 1024 * 1024;
const TRIM_KEEP_BYTES = 6 * 1024 * 1024;

export type TrafficVia = "tor" | "clearnet";

export type TrafficClearnetReason =
  | "no-tor-session"
  | "loopback"
  | "rpc-allowlist"
  | "tor-disabled"
  | "rpc";

export type TrafficCategory =
  | "pimlico"
  | "subsquid"
  | "ppoi"
  | "saga"
  | "asp"
  | "fastrelay"
  | "artifacts"
  | "rpc"
  | "other";

export type NetworkTrafficEntry = {
  ts: string;
  kind: "http" | "rpc" | "pimlico";
  method: string;
  url: string;
  host: string;
  via: TrafficVia;
  clearnetReason?: TrafficClearnetReason;
  category: TrafficCategory;
  status?: number;
  ok?: boolean;
  durationMs?: number;
  error?: string;
  requestBytes?: number;
  responseBytes?: number;
  /** JSON-RPC method when kind is rpc or identifiable from HTTP body. */
  rpcMethod?: string;
};

type TrafficStore = { walletDir: string };

const als = new AsyncLocalStorage<TrafficStore>();

export function networkTrafficLogPath(walletDir: string): string {
  return join(walletDir, NETWORK_TRAFFIC_LOG_FILENAME);
}

/** Run `fn` so all instrumented traffic is attributed to this wallet. */
export function runWithTrafficLogWallet<T>(
  walletDir: string,
  fn: () => Promise<T>
): Promise<T> {
  return als.run({ walletDir }, fn);
}

export function getTrafficLogWalletDir(): string | null {
  return als.getStore()?.walletDir ?? null;
}

/** Redact API-key-like path segments and sensitive query values. */
export function redactUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return raw.length > 200 ? `${raw.slice(0, 200)}…` : raw;
  }

  const host = url.hostname.toLowerCase();
  // Public Pimlico bundler is keyless (`/v2/<chainId>/rpc`); never redact it.
  if (host === "public.pimlico.io" || host.endsWith(".pimlico.io")) {
    return url.toString();
  }
  // Local / loopback RPC (Anvil, Hardhat, local node) — no API key in the URL.
  if (
    host === "127.0.0.1" ||
    host === "localhost" ||
    host === "::1" ||
    host === "[::1]" ||
    host.endsWith(".localhost")
  ) {
    return url.toString();
  }

  // Infura / Alchemy style: /v3/<key>, /v2/<key> — but not decimal chain ids.
  url.pathname = url.pathname.replace(
    /(\/v[23]\/)([A-Za-z0-9_-]{8,})/g,
    (full, prefix: string, seg: string) =>
      /^\d+$/.test(seg) ? full : `${prefix}<redacted>`
  );
  // Generic long hex/base58 path segments
  url.pathname = url.pathname.replace(
    /\/([A-Fa-f0-9]{32,}|[A-Za-z0-9_-]{40,})(?=\/|$)/g,
    "/<redacted>"
  );

  for (const key of [...url.searchParams.keys()]) {
    const lower = key.toLowerCase();
    if (
      lower.includes("key") ||
      lower.includes("token") ||
      lower.includes("secret") ||
      lower.includes("auth") ||
      lower === "apikey"
    ) {
      url.searchParams.set(key, "<redacted>");
    }
  }

  return url.toString();
}

export function categorizeUrl(urlStr: string): TrafficCategory {
  const lower = urlStr.toLowerCase();
  if (lower.includes("pimlico.io")) return "pimlico";
  if (lower.includes("squids.live") || lower.includes("subsquid")) return "subsquid";
  if (lower.includes("ppoi.") || lower.includes("/poi")) return "ppoi";
  if (lower.includes("saga.fatsolutions")) return "saga";
  if (lower.includes("0xbow.io")) return "asp";
  if (lower.includes("fastrelay.xyz")) return "fastrelay";
  if (
    lower.includes("githubusercontent.com") ||
    lower.includes("privacy-protocol-artifacts") ||
    lower.includes("tornadoprowing") ||
    lower.includes("tornado.json") ||
    lower.includes("provingkey")
  ) {
    return "artifacts";
  }
  return "other";
}

function hostnameOf(urlStr: string): string {
  try {
    return new URL(urlStr).hostname || "?";
  } catch {
    return "?";
  }
}

function maybeTrimLogFile(path: string): void {
  if (!existsSync(path)) return;
  const buf = readFileSync(path);
  if (buf.length <= MAX_LOG_BYTES) return;

  // Keep the trailing window on a line boundary.
  const slice = buf.subarray(buf.length - TRIM_KEEP_BYTES);
  const firstNl = slice.indexOf(0x0a);
  const kept = firstNl >= 0 ? slice.subarray(firstNl + 1) : slice;
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, kept);
  renameSync(tmp, path);
}

export function appendNetworkTraffic(
  partial: Omit<NetworkTrafficEntry, "ts" | "url" | "host" | "category"> & {
    url: string;
    category?: TrafficCategory;
    host?: string;
  }
): void {
  const walletDir = getTrafficLogWalletDir();
  if (!walletDir) return;

  const url = redactUrl(partial.url);
  const entry: NetworkTrafficEntry = {
    ts: new Date().toISOString(),
    kind: partial.kind,
    method: partial.method,
    url,
    host: partial.host ?? hostnameOf(url),
    via: partial.via,
    category: partial.category ?? categorizeUrl(url),
    ...(partial.clearnetReason ? { clearnetReason: partial.clearnetReason } : {}),
    ...(partial.status !== undefined ? { status: partial.status } : {}),
    ...(partial.ok !== undefined ? { ok: partial.ok } : {}),
    ...(partial.durationMs !== undefined ? { durationMs: partial.durationMs } : {}),
    ...(partial.error ? { error: partial.error.slice(0, 500) } : {}),
    ...(partial.requestBytes !== undefined
      ? { requestBytes: partial.requestBytes }
      : {}),
    ...(partial.responseBytes !== undefined
      ? { responseBytes: partial.responseBytes }
      : {}),
    ...(partial.rpcMethod ? { rpcMethod: partial.rpcMethod } : {}),
  };

  try {
    mkdirSync(dirname(networkTrafficLogPath(walletDir)), { recursive: true });
    const path = networkTrafficLogPath(walletDir);
    appendFileSync(path, `${JSON.stringify(entry)}\n`, { encoding: "utf8" });
    maybeTrimLogFile(path);
  } catch {
    // Logging must never break wallet operations.
  }
}

export function readNetworkTrafficLog(walletDir: string): NetworkTrafficEntry[] {
  const path = networkTrafficLogPath(walletDir);
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8");
  const out: NetworkTrafficEntry[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as NetworkTrafficEntry);
    } catch {
      // skip corrupt line
    }
  }
  return out;
}

export function clearNetworkTrafficLog(walletDir: string): boolean {
  const path = networkTrafficLogPath(walletDir);
  if (!existsSync(path)) return false;
  unlinkSync(path);
  return true;
}

export function formatTrafficEntryLine(entry: NetworkTrafficEntry): string {
  const via = entry.via === "tor" ? "TOR" : "CLR";
  const status =
    entry.status != null
      ? String(entry.status)
      : entry.ok === false
        ? "ERR"
        : entry.error
          ? "ERR"
          : "—";
  const ms = entry.durationMs != null ? `${entry.durationMs}ms` : "";
  const rpc = entry.rpcMethod ? ` ${entry.rpcMethod}` : "";
  const reason = entry.clearnetReason ? ` (${entry.clearnetReason})` : "";
  return `${entry.ts}  ${via.padEnd(3)}  ${entry.category.padEnd(10)}  ${entry.method.padEnd(6)}  ${status.padEnd(3)}  ${ms.padStart(7)}  ${entry.host}${rpc}  ${entry.url}${reason}`;
}
