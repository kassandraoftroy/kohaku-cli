/**
 * Route non-RPC HTTP through Tor for the duration of a session.
 *
 * Two mechanisms (both needed):
 * 1. Patch `globalThis.fetch` + `kohakuFetch` — covers Host.network, Railgun
 *    WASM (Subsquid / PPOI / artifacts), Tornado artifact loader (main-thread
 *    proxy), Privacy Pools ASP / fastrelay via Host.
 * 2. Localhost reverse proxy for Pimlico — Tornado prepare/estimate runs in a
 *    worker that cannot see the main-process fetch patch; Railgun WASM also
 *    fetches the configured bundler URL. Pointing that URL at 127.0.0.1 covers
 *    both. Loopback requests stay on clearnet (they hit this proxy).
 *
 * Proving artifacts are read from the installed `kohaku-artifacts` package.
 * SDK requests for the old GitHub and mirror URLs are answered from that
 * package and are not downloaded.
 * Saga CDN (Tornado event sync): Tor-or-fail (no clearnet fallback).
 * Subsquid GraphQL and saga CDN responses are also stored under
 * `<dataDir>/public-sync-cache` so later wallets reuse public Railgun/Tornado pages.
 * Artifacts are for prove/unshield, not pool-event sync.
 *
 * Set `KOHAKU_TOR_DEBUG=1` for per-request Tor logs on stderr. POST bodies are
 * logged as `post-body` lines, truncated to 4KB.
 * Optional `KOHAKU_TOR_CDN_TIMEOUT_MS` (default 45000) caps large Tor GETs.
 *
 * Ethereum RPC stays clearnet: viem http transport uses fetch (not Tor by default). Hosts
 * from `rpcUrl` are also allowlisted so ox / eth-prices fetch-to-RPC stays off Tor.
 */
import { existsSync, rmSync } from "node:fs";
import http from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { AddressInfo } from "node:net";
import { TorClient } from "tor-js/wasm-file";

import {
  appendNetworkTraffic,
  categorizeUrl,
  runWithTrafficLogWallet,
  type TrafficCategory,
  type TrafficClearnetReason,
} from "./network-traffic-log.js";
import { beginSyncActivity } from "./sync-progress.js";
import { formatCaughtError, withTorBootstrapHint } from "./cli-errors.js";
import {
  artifactRelativeKeyFromUrl,
  buildLocalArtifactResponse,
  readPackagedArtifactOrThrow,
} from "./proving-artifacts.js";
import {
  buildCachedPublicSyncResponse,
  cachePublicSyncNetworkResponse,
  isPublicSyncCacheableRequest,
  isImmutableSubsquidRequest,
  readPublicSyncCache,
  setPublicSyncCacheDataDir,
} from "./public-sync-cache.js";

/** tor-js Arti directory cache (`createAutoStorage('tor-js')`). */
export function torJsCacheDir(): string {
  return join(homedir(), ".local", "share", "tor-js");
}

/**
 * Delete the on-disk tor-js cache. Fixes bootstrap failures like
 * "corrupted data in cache: Unable to bootstrap a working directory".
 * Next Tor start re-downloads consensus (slower first bootstrap).
 */
export function clearTorJsCache(): { cleared: boolean; path: string } {
  const path = torJsCacheDir();
  if (!existsSync(path)) return { cleared: false, path };
  rmSync(path, { recursive: true, force: true });
  return { cleared: true, path };
}

const PIMLICO_ORIGIN = "https://public.pimlico.io";
const PIMLICO_ALLOWED_PATH = /^\/v2\/\d+\/rpc$/;

/** Default Tor attempt budget for large CDN/artifact GETs (then fail). */
const DEFAULT_TOR_CDN_TIMEOUT_MS = 45_000;

type ActiveTorSession = {
  client: TorClient;
  pimlicoBaseUrl: string;
  clearnetHosts: Set<string>;
  close: () => Promise<void>;
};

let activeSession: ActiveTorSession | null = null;
let clearnetFetch: typeof fetch = globalThis.fetch.bind(globalThis);
let fetchPatched = false;

function torDebug(...args: unknown[]): void {
  if (process.env.KOHAKU_TOR_DEBUG?.trim()) {
    console.error("[kohaku-tor]", ...args);
  }
}

function resolveTorCdnTimeoutMs(): number {
  const raw = process.env.KOHAKU_TOR_CDN_TIMEOUT_MS?.trim();
  if (!raw) return DEFAULT_TOR_CDN_TIMEOUT_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1_000) return DEFAULT_TOR_CDN_TIMEOUT_MS;
  return Math.floor(n);
}

/** Railgun, Tornado, and Privacy Pools unshield talk to public Pimlico. */
export function protocolUsesPimlicoBundler(protocol: string): boolean {
  return protocol === "railgun" || protocol === "tornado";
}

/** Hostname from an absolute URL, or null if unparseable. */
export function hostnameFromUrl(url: string): string | null {
  try {
    const host = new URL(url).hostname.trim().toLowerCase();
    return host || null;
  } catch {
    return null;
  }
}

/**
 * Add clearnet allowlist hosts while a Tor session is active (e.g. TUI learns
 * RPC URL after bootstrap). No-op when Tor is off.
 */
export function addTorClearnetHosts(hosts: Iterable<string>): void {
  if (!activeSession) return;
  for (const h of hosts) {
    const trimmed = h.trim().toLowerCase();
    if (trimmed) activeSession.clearnetHosts.add(trimmed);
  }
}

/**
 * Bundler JSON-RPC URL for the given chain. When a Tor session is active,
 * returns the local Pimlico proxy URL so workers / WASM stay off clearnet.
 */
export function resolvePimlicoBundlerUrl(chainId: bigint): string {
  const path = `/v2/${chainId.toString()}/rpc`;
  if (activeSession) {
    return `${activeSession.pimlicoBaseUrl}${path}`;
  }
  return `${PIMLICO_ORIGIN}${path}`;
}

function resolveRequestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function isLoopbackHostname(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === "127.0.0.1" || h === "localhost" || h === "::1" || h === "[::1]";
}

function shouldUseClearnet(urlStr: string): {
  clearnet: boolean;
  reason?: TrafficClearnetReason;
} {
  try {
    const u = new URL(urlStr);
    if (isLoopbackHostname(u.hostname)) {
      return { clearnet: true, reason: "loopback" };
    }
    if (activeSession?.clearnetHosts.has(u.hostname.toLowerCase())) {
      return { clearnet: true, reason: "rpc-allowlist" };
    }
    if (!activeSession) {
      return { clearnet: true, reason: "no-tor-session" };
    }
    return { clearnet: false };
  } catch {
    return { clearnet: true, reason: "no-tor-session" };
  }
}

function isActivePimlicoProxyUrl(urlStr: string): boolean {
  return !!activeSession && urlStr.startsWith(activeSession.pimlicoBaseUrl);
}

function estimateBodyBytes(body: unknown): number | undefined {
  if (body == null) return undefined;
  if (typeof body === "string") return Buffer.byteLength(body);
  if (body instanceof Uint8Array) return body.byteLength;
  if (body instanceof ArrayBuffer) return body.byteLength;
  return undefined;
}

function headersToRecord(
  headers: HeadersInit | undefined
): Record<string, string> | undefined {
  if (!headers) return undefined;
  if (headers instanceof Headers) {
    const out: Record<string, string> = {};
    headers.forEach((value, key) => {
      out[key] = value;
    });
    return out;
  }
  if (Array.isArray(headers)) {
    const out: Record<string, string> = {};
    for (const [key, value] of headers) out[key] = value;
    return out;
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value !== undefined) out[key] = String(value);
  }
  return out;
}

async function bodyToTorBody(
  body: BodyInit | null | undefined
): Promise<string | Uint8Array | ArrayBuffer | undefined> {
  if (body == null) return undefined;
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return body;
  if (body instanceof URLSearchParams) return body.toString();
  if (typeof Blob !== "undefined" && body instanceof Blob) {
    return new Uint8Array(await body.arrayBuffer());
  }
  if (typeof ReadableStream !== "undefined" && body instanceof ReadableStream) {
    const buf = await new Response(body).arrayBuffer();
    return new Uint8Array(buf);
  }
  const buf = await new Response(body).arrayBuffer();
  return new Uint8Array(buf);
}

async function toTorInit(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<{
  method?: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array | ArrayBuffer;
  signal?: AbortSignal;
}> {
  const fromRequest = typeof Request !== "undefined" && input instanceof Request;
  const method = init?.method ?? (fromRequest ? input.method : undefined);
  const headers = headersToRecord(
    init?.headers ?? (fromRequest ? input.headers : undefined)
  );
  const signal = init?.signal ?? (fromRequest ? input.signal : undefined);
  let body: BodyInit | null | undefined = init?.body;
  if (body === undefined && fromRequest && input.method !== "GET" && input.method !== "HEAD") {
    body = await input.arrayBuffer();
  }
  const torBody = await bodyToTorBody(body);
  return {
    ...(method ? { method } : {}),
    ...(headers ? { headers } : {}),
    ...(torBody !== undefined ? { body: torBody } : {}),
    ...(signal ? { signal } : {}),
  };
}

async function loggedFetch(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  meta: {
    via: "tor" | "clearnet";
    clearnetReason?: TrafficClearnetReason;
    url: string;
    category?: "pimlico";
    requestBytes?: number;
    rpcMethod?: string;
  },
  doFetch: () => Promise<Response>
): Promise<Response> {
  const method =
    init?.method ??
    (typeof Request !== "undefined" && input instanceof Request
      ? input.method
      : "GET");
  const started = Date.now();
  const category = meta.category ?? categorizeUrl(meta.url);
  try {
    const fetched = await doFetch();
    let responseBytes: number | undefined;
    const cl = fetched.headers.get("content-length");
    if (cl && /^\d+$/.test(cl)) responseBytes = Number(cl);
    const res = fetched;
    appendNetworkTraffic({
      kind: meta.category === "pimlico" ? "pimlico" : "http",
      method: method.toUpperCase(),
      url: meta.url,
      via: meta.via,
      clearnetReason: meta.clearnetReason,
      category: meta.category,
      status: res.status,
      ok: res.ok,
      durationMs: Date.now() - started,
      requestBytes: meta.requestBytes,
      responseBytes,
      rpcMethod: meta.rpcMethod,
    });
    return res;
  } catch (err) {
    appendNetworkTraffic({
      kind: meta.category === "pimlico" ? "pimlico" : "http",
      method: method.toUpperCase(),
      url: meta.url,
      via: meta.via,
      clearnetReason: meta.clearnetReason,
      category: meta.category,
      ok: false,
      durationMs: Date.now() - started,
      requestBytes: meta.requestBytes,
      rpcMethod: meta.rpcMethod,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

/**
 * tor-js builds Responses via `new Response(...)`, so `.url` is always "".
 * Railgun's reqwest-wasm parses `response.url()` after fetch and throws
 * "url parse" on the empty string. Stamp the request URL onto the instance.
 */
function withRequestUrl(res: Response, requestUrl: string): Response {
  if (res.url) return res;
  try {
    Object.defineProperty(res, "url", {
      value: requestUrl,
      configurable: true,
      enumerable: true,
    });
  } catch {
    // Non-configurable in some environments; caller still gets the body.
  }
  return res;
}

const POST_BODY_LOG_MAX = 4096;

function bodyInitToUtf8(body: BodyInit): string | undefined {
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) return Buffer.from(body).toString("utf8");
  if (body instanceof ArrayBuffer) return Buffer.from(body).toString("utf8");
  if (ArrayBuffer.isView(body)) {
    return Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString(
      "utf8"
    );
  }
  return undefined;
}

/**
 * JSON-RPC method from a POST body, without consuming a `Request` body.
 * `KOHAKU_TOR_DEBUG=1` also prints the body (truncated) as a `post-body` line.
 */
async function peekPostRpcMethod(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  method: string
): Promise<string | undefined> {
  if (method !== "POST") return undefined;
  let text: string | undefined;
  if (init?.body != null) {
    text = bodyInitToUtf8(init.body);
  } else if (typeof Request !== "undefined" && input instanceof Request) {
    try {
      text = await input.clone().text();
    } catch {
      text = undefined;
    }
  }
  if (text == null) return undefined;
  if (process.env.KOHAKU_TOR_DEBUG?.trim()) {
    const shown =
      text.length > POST_BODY_LOG_MAX
        ? `${text.slice(0, POST_BODY_LOG_MAX)}…`
        : text;
    torDebug("post-body", shown);
  }
  return peekJsonRpcMethod(Buffer.from(text));
}

/** Saga CDN (gordosoluciones host; legacy Fastly / fatsolutions still detected). */
function isSagaCdnUrl(urlStr: string): boolean {
  try {
    const host = new URL(urlStr).hostname.toLowerCase();
    return (
      host === "saga.gordosoluciones.xyz" ||
      host === "saga-pp-state.global.ssl.fastly.net" ||
      host.includes("saga.fatsolutions")
    );
  } catch {
    return false;
  }
}

/** Large GETs that use a hard Tor timeout (no clearnet fallback). */
function needsTorHardTimeout(urlStr: string, method: string): boolean {
  if (method !== "GET" && method !== "HEAD") return false;
  return isSagaCdnUrl(urlStr);
}

async function raceTorFetch(
  doFetch: () => Promise<Response>,
  timeoutMs: number
): Promise<Response> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      doFetch(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(
            new Error(`Tor CDN fetch timed out after ${timeoutMs}ms`)
          );
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function resolveRequestMethod(
  input: RequestInfo | URL,
  init?: RequestInit
): string {
  const method =
    init?.method ??
    (typeof Request !== "undefined" && input instanceof Request
      ? input.method
      : "GET");
  return method.toUpperCase();
}

async function requestBodyBytesForCache(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Buffer> {
  const body = init?.body;
  if (typeof body === "string") return Buffer.from(body);
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (typeof ArrayBuffer !== "undefined" && body instanceof ArrayBuffer) {
    return Buffer.from(body);
  }
  if (ArrayBuffer.isView(body)) {
    return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  }
  if (
    typeof Request !== "undefined" &&
    input instanceof Request &&
    init?.body === undefined
  ) {
    const m = input.method.toUpperCase();
    if (m !== "GET" && m !== "HEAD") {
      return Buffer.from(await input.clone().arrayBuffer());
    }
  }
  return Buffer.alloc(0);
}

async function storePublicSyncResponseIfOk(
  url: string,
  method: string,
  reqBody: Buffer,
  cacheable: boolean,
  res: Response
): Promise<Response> {
  if (!cacheable || res.status !== 200) return res;
  const buf = Buffer.from(await res.arrayBuffer());
  cachePublicSyncNetworkResponse({
    method,
    url,
    body: reqBody,
    status: 200,
    responseBody: buf,
    contentType: res.headers.get("content-type"),
  });
  return buildCachedPublicSyncResponse(
    url,
    buf,
    res.headers.get("content-type")
  );
}

/**
 * Fetch that uses Tor when a session is active (except loopback / allowlisted
 * RPC hosts). Safe to bind as `Host.network.fetch` — always checks live session.
 * Always records traffic when a wallet log context is active.
 *
 * Proving artifacts: the kohaku-artifacts package. A missing file throws.
 * Saga CDN: Tor-or-fail with hard timeout.
 */
export async function kohakuFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const category = categorizeUrl(resolveRequestUrl(input));
  const method = resolveRequestMethod(input, init);
  const rpcMethod = await peekPostRpcMethod(input, init, method);
  const label = category === "subsquid" ? "Subsquid history · fetching page"
    : category === "ppoi" && rpcMethod === "ppoi_poi_merkletree_leaves"
      ? "Railgun PPOI list · loading leaves (size unknown)"
    : category === "ppoi" ? "Railgun PPOI · checking list / TXIDs"
    : category === "asp" ? "ASP lists · fetching"
    : rpcMethod ? `RPC ${rpcMethod} · waiting for response` : undefined;
  const finish = label ? beginSyncActivity(label) : undefined;
  try {
    return await kohakuFetchInner(input, init, rpcMethod);
  } finally {
    finish?.();
  }
}

async function kohakuFetchInner(
  input: RequestInfo | URL,
  init?: RequestInit,
  rpcMethod?: string,
): Promise<Response> {
  const url = resolveRequestUrl(input);
  const method = resolveRequestMethod(input, init);

  // Hits to the local Pimlico proxy are logged in the proxy (upstream Tor URL).
  if (isActivePimlicoProxyUrl(url)) {
    return clearnetFetch(input, init);
  }

  const artifactKey =
    method === "GET" || method === "HEAD"
      ? artifactRelativeKeyFromUrl(url)
      : null;

  if (artifactKey) {
    const body = readPackagedArtifactOrThrow(artifactKey);
    torDebug("local-artifact", method, artifactKey);
    return loggedFetch(
      input,
      init,
      {
        via: "clearnet",
        clearnetReason: "local-artifact",
        url,
        rpcMethod,
      },
      async () => buildLocalArtifactResponse(url, body)
    );
  }

  const candidate = isPublicSyncCacheableRequest(url, method);
  const reqBody = candidate
    ? await requestBodyBytesForCache(input, init)
    : Buffer.alloc(0);
  const cacheable = candidate && (categorizeUrl(url) !== "subsquid" ||
    (method === "POST" && isImmutableSubsquidRequest(reqBody)));
  if (cacheable) {
    const cached = readPublicSyncCache({ method, url, body: reqBody });
    if (cached) {
      return loggedFetch(
        input,
        init,
        {
          via: "clearnet",
          clearnetReason: "public-sync-cache",
          url,
          rpcMethod,
        },
        async () =>
          buildCachedPublicSyncResponse(url, cached.body, cached.contentType)
      );
    }
  }

  const wrapStore = (inner: () => Promise<Response>) => async () =>
    storePublicSyncResponseIfOk(url, method, reqBody, cacheable, await inner());

  const decision = shouldUseClearnet(url);
  if (decision.clearnet) {
    return loggedFetch(
      input,
      init,
      {
        via: "clearnet",
        clearnetReason: decision.reason,
        url,
        rpcMethod,
      },
      wrapStore(() => clearnetFetch(input, init))
    );
  }

  const torInit = await toTorInit(input, init);
  const requestBytes = estimateBodyBytes(torInit.body);
  const hardTimeout = needsTorHardTimeout(url, method);

  if (!hardTimeout) {
    torDebug("tor", method, url);
    return loggedFetch(
      input,
      init,
      {
        via: "tor",
        url,
        requestBytes,
        rpcMethod,
      },
      wrapStore(async () =>
        withRequestUrl(await activeSession!.client.fetch(url, torInit), url)
      )
    );
  }

  const timeoutMs = resolveTorCdnTimeoutMs();
  torDebug(`tor hard-timeout(${timeoutMs}ms)`, method, url);

  try {
    const torRes = await raceTorFetch(
      () =>
        loggedFetch(
          input,
          init,
          {
            via: "tor",
            url,
            requestBytes,
            rpcMethod,
          },
          wrapStore(async () =>
            withRequestUrl(await activeSession!.client.fetch(url, torInit), url)
          )
        ),
      timeoutMs
    );
    if (!torRes.ok) {
      throw new Error(
        `Tor fetch returned HTTP ${torRes.status} for ${url}` +
          (isSagaCdnUrl(url)
            ? " (saga CDN). Check Tor / KOHAKU_TOR_DEBUG=1."
            : "")
      );
    }
    return torRes;
  } catch (e) {
    const msg = formatCaughtError(e);
    if (/Tor fetch returned HTTP/i.test(msg)) throw e;
    throw new Error(
      `Tor fetch failed for ${url}: ${msg}` +
        (isSagaCdnUrl(url)
          ? " (saga CDN; no clearnet fallback)."
          : "")
    );
  }
}

/** Install logging/Tor fetch wrapper for the process (idempotent; kept for life). */
export function ensureKohakuFetchPatch(): void {
  if (fetchPatched) return;
  clearnetFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = kohakuFetch as typeof fetch;
  fetchPatched = true;
}

function readRequestBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer | string) => {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function sendProxyError(
  res: http.ServerResponse,
  status: number,
  message: string
): void {
  if (res.headersSent) return;
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { message } }));
}

function peekJsonRpcMethod(body: Buffer): string | undefined {
  try {
    const parsed = JSON.parse(body.toString("utf8")) as { method?: unknown };
    return typeof parsed.method === "string" ? parsed.method : undefined;
  } catch {
    return undefined;
  }
}

async function startPimlicoProxy(client: TorClient): Promise<{
  baseUrl: string;
  server: http.Server;
}> {
  const server = http.createServer((req, res) => {
    void (async () => {
      const started = Date.now();
      try {
        if (req.method !== "POST") {
          sendProxyError(res, 405, "Method not allowed");
          return;
        }
        const path = req.url?.split("?")[0] ?? "";
        if (!PIMLICO_ALLOWED_PATH.test(path)) {
          sendProxyError(res, 404, "Not found");
          return;
        }

        const body = await readRequestBody(req);
        const upstream = `${PIMLICO_ORIGIN}${path}`;
        const rpcMethod = peekJsonRpcMethod(body);
        try {
          const torRes = await client.fetch(upstream, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body,
          });

          const responseBody = Buffer.from(await torRes.arrayBuffer());
          const contentType =
            torRes.headers.get("content-type") ?? "application/json";
          appendNetworkTraffic({
            kind: "pimlico",
            method: "POST",
            url: upstream,
            via: "tor",
            category: "pimlico",
            status: torRes.status,
            ok: torRes.ok,
            durationMs: Date.now() - started,
            requestBytes: body.byteLength,
            responseBytes: responseBody.byteLength,
            rpcMethod,
          });
          res.writeHead(torRes.status, { "content-type": contentType });
          res.end(responseBody);
        } catch (err) {
          appendNetworkTraffic({
            kind: "pimlico",
            method: "POST",
            url: upstream,
            via: "tor",
            category: "pimlico",
            ok: false,
            durationMs: Date.now() - started,
            requestBytes: body.byteLength,
            rpcMethod,
            error: err instanceof Error ? err.message : String(err),
          });
          throw err;
        }
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Tor proxy request failed";
        sendProxyError(res, 502, message);
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const addr = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    server,
  };
}

function envDisablesTor(): boolean {
  const v = process.env.KOHAKU_WITHOUT_TOR?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

export type WithTorOptions = {
  onStatus?: (message: string) => void;
  /** Absolute RPC URL — its hostname stays on clearnet for fetch-based callers. */
  rpcUrl?: string;
  /** Extra clearnet hostnames (lowercase comparison). */
  clearnetHosts?: Iterable<string>;
  /** Attribute traffic log rows to this wallet directory. */
  walletDir?: string;
};

/**
 * Attribute network traffic to `walletDir` and ensure fetch logging is installed.
 */
export function runWithWalletTrafficLog<T>(
  walletDir: string,
  fn: () => Promise<T>
): Promise<T> {
  ensureKohakuFetchPatch();
  setPublicSyncCacheDataDir(dirname(walletDir));
  return runWithTrafficLogWallet(walletDir, fn);
}

/**
 * When `enabled`, bootstraps Tor and installs the Pimlico localhost proxy for
 * the duration of `fn`. Nested calls reuse the same session. The global fetch
 * logging patch stays installed for the process. Set `KOHAKU_WITHOUT_TOR=1`
 * to force-disable Tor routing.
 */
export async function withTor<T>(
  enabled: boolean,
  opts: WithTorOptions,
  fn: () => Promise<T>
): Promise<T> {
  const run = () => withTorInner(enabled, opts, fn);
  if (opts.walletDir) {
    return runWithWalletTrafficLog(opts.walletDir, run);
  }
  ensureKohakuFetchPatch();
  return run();
}

async function withTorInner<T>(
  enabled: boolean,
  opts: WithTorOptions,
  fn: () => Promise<T>
): Promise<T> {
  if (!enabled || envDisablesTor()) {
    return fn();
  }
  if (activeSession) {
    if (opts.rpcUrl) {
      const host = hostnameFromUrl(opts.rpcUrl);
      if (host) activeSession.clearnetHosts.add(host);
    }
    if (opts.clearnetHosts) {
      addTorClearnetHosts(opts.clearnetHosts);
    }
    return fn();
  }

  opts.onStatus?.("Starting Tor");
  const client = process.env.KOHAKU_TOR_DEBUG
    ? new TorClient({ logLevel: "info" })
    : new TorClient();

  try {
    await client.ready();
    opts.onStatus?.("Tor ready; routing non-RPC HTTP via Tor");
    const { baseUrl, server } = await startPimlicoProxy(client);

    const clearnetHosts = new Set<string>();
    if (opts.rpcUrl) {
      const host = hostnameFromUrl(opts.rpcUrl);
      if (host) clearnetHosts.add(host);
    }
    if (opts.clearnetHosts) {
      for (const h of opts.clearnetHosts) {
        const trimmed = h.trim().toLowerCase();
        if (trimmed) clearnetHosts.add(trimmed);
      }
    }

    let closed = false;
    const close = async () => {
      if (closed) return;
      closed = true;
      if (activeSession?.pimlicoBaseUrl === baseUrl) {
        activeSession = null;
      }
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      client.close();
    };

    activeSession = {
      client,
      pimlicoBaseUrl: baseUrl,
      clearnetHosts,
      close,
    };

    try {
      return await fn();
    } finally {
      await close();
    }
  } catch (err) {
    client.close();
    // Enrich tor-js "Bootstrap failed: tor: …" so callers that print
    // `err.message` (not only cliError) still see the clear-tor-cache hint.
    if (err instanceof Error) {
      const hinted = withTorBootstrapHint(err.message);
      if (hinted !== err.message) {
        throw new Error(hinted, { cause: err });
      }
    }
    throw err;
  }
}

/** @deprecated Use {@link withTor}. */
export const withPimlicoTor = withTor;
