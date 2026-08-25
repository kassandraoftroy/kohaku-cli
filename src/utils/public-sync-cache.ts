import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { gzipSync } from "node:zlib";

import { categorizeUrl } from "./network-traffic-log.js";

const DEFAULT_MAX_BYTES = 1024 * 1024 * 1024;
const DEFAULT_MAX_ENTRY_BYTES = 50 * 1024 * 1024;
const CACHE_KEY_FILE_RE = /^[a-f0-9]{64}\.(bin|json)$/;

function defaultDataDir(): string {
  return join(homedir(), ".kohaku-cli");
}

let activeDataDir: string = defaultDataDir();

export function publicSyncCacheDir(dataDir: string = activeDataDir): string {
  return join(dataDir, "public-sync-cache");
}

export function getPublicSyncCacheDataDir(): string {
  return activeDataDir;
}

export function setPublicSyncCacheDataDir(dataDir: string): void {
  activeDataDir = dataDir;
}

export function isPublicSyncCacheableUrl(url: string): boolean {
  const category = categorizeUrl(url);
  return category === "subsquid" || category === "saga";
}

export function isPublicSyncCacheableRequest(
  url: string,
  method: string
): boolean {
  const m = method.toUpperCase();
  if (m !== "GET" && m !== "HEAD" && m !== "POST") return false;
  return isPublicSyncCacheableUrl(url);
}

export function publicSyncCacheKey(
  method: string,
  url: string,
  body: Uint8Array | Buffer | string = ""
): string {
  const h = createHash("sha256");
  h.update(method.toUpperCase());
  h.update("\n");
  h.update(url);
  h.update("\n");
  if (typeof body === "string") h.update(body);
  else h.update(body);
  return h.digest("hex");
}

type CacheMeta = {
  url: string;
  method: string;
  contentType: string | null;
  storedAt: string;
  bytes: number;
};

function metaPath(dir: string, key: string): string {
  return join(dir, `${key}.json`);
}

function bodyPath(dir: string, key: string): string {
  return join(dir, `${key}.bin`);
}

export function publicSyncCacheHasEntries(
  dataDir: string = activeDataDir
): boolean {
  const dir = publicSyncCacheDir(dataDir);
  if (!existsSync(dir)) return false;
  return readdirSync(dir).some((name) => name.endsWith(".bin"));
}

export function clearPublicSyncCache(
  dataDir: string = activeDataDir
): { cleared: boolean; path: string; filesRemoved: number } {
  const dir = publicSyncCacheDir(dataDir);
  if (!existsSync(dir)) {
    return { cleared: false, path: dir, filesRemoved: 0 };
  }
  const files = readdirSync(dir);
  rmSync(dir, { recursive: true, force: true });
  return { cleared: files.length > 0, path: dir, filesRemoved: files.length };
}

function maxCacheBytes(): number {
  const raw = process.env.KOHAKU_PUBLIC_SYNC_CACHE_MAX_BYTES?.trim();
  if (raw && /^\d+$/.test(raw)) return Number(raw);
  return DEFAULT_MAX_BYTES;
}

function cacheBytesOnDisk(dir: string): number {
  if (!existsSync(dir)) return 0;
  let total = 0;
  for (const name of readdirSync(dir)) {
    if (!CACHE_KEY_FILE_RE.test(name)) continue;
    try {
      total += statSync(join(dir, name)).size;
    } catch {
      // ignore unreadable entries
    }
  }
  return total;
}

/**
 * The cache never evicts: once it is full, new responses simply are not stored.
 * Entries already on disk (notably an installed snapshot) are therefore never
 * dropped to make room for fresher pages, which would silently punch holes in a
 * snapshot the user intends to keep or republish.
 */
function hasRoomFor(dir: string, key: string, incomingBytes: number): boolean {
  const max = maxCacheBytes();
  let total = cacheBytesOnDisk(dir);
  // Refreshing an existing key replaces its bytes rather than adding to them.
  for (const path of [bodyPath(dir, key), metaPath(dir, key)]) {
    try {
      if (existsSync(path)) total -= statSync(path).size;
    } catch {
      // ignore unreadable entries
    }
  }
  return total + incomingBytes <= max;
}

export function readPublicSyncCache(opts: {
  method: string;
  url: string;
  body?: Uint8Array | Buffer | string;
  dataDir?: string;
}): { body: Buffer; contentType: string | null } | null {
  const dir = publicSyncCacheDir(opts.dataDir ?? activeDataDir);
  const key = publicSyncCacheKey(opts.method, opts.url, opts.body ?? "");
  const bin = bodyPath(dir, key);
  const metaFile = metaPath(dir, key);
  if (!existsSync(bin) || !existsSync(metaFile)) return null;
  try {
    const meta = JSON.parse(readFileSync(metaFile, "utf8")) as CacheMeta;
    const body = readFileSync(bin);
    return { body, contentType: meta.contentType ?? null };
  } catch {
    return null;
  }
}

/** Persist a network response only when it is HTTP 200. */
export function cachePublicSyncNetworkResponse(opts: {
  method: string;
  url: string;
  body?: Uint8Array | Buffer | string;
  status: number;
  responseBody: Uint8Array | Buffer;
  contentType?: string | null;
  dataDir?: string;
}): void {
  if (opts.status !== 200) return;
  writePublicSyncCache({
    method: opts.method,
    url: opts.url,
    body: opts.body,
    responseBody: opts.responseBody,
    contentType: opts.contentType,
    dataDir: opts.dataDir,
  });
}

export function writePublicSyncCache(opts: {
  method: string;
  url: string;
  body?: Uint8Array | Buffer | string;
  responseBody: Uint8Array | Buffer;
  contentType?: string | null;
  dataDir?: string;
}): void {
  const responseBody = Buffer.from(opts.responseBody);
  if (responseBody.byteLength > DEFAULT_MAX_ENTRY_BYTES) return;

  const dir = publicSyncCacheDir(opts.dataDir ?? activeDataDir);
  const key = publicSyncCacheKey(opts.method, opts.url, opts.body ?? "");
  const meta: CacheMeta = {
    url: opts.url,
    method: opts.method.toUpperCase(),
    contentType: opts.contentType ?? null,
    storedAt: new Date().toISOString(),
    bytes: responseBody.byteLength,
  };
  const metaBody = JSON.stringify(meta);

  mkdirSync(dir, { recursive: true });
  if (
    !hasRoomFor(dir, key, responseBody.byteLength + Buffer.byteLength(metaBody))
  ) {
    return;
  }

  writeFileSync(bodyPath(dir, key), responseBody);
  writeFileSync(metaPath(dir, key), metaBody);
}

export function buildCachedPublicSyncResponse(
  requestUrl: string,
  body: Buffer,
  contentType: string | null
): Response {
  const copy = Uint8Array.from(body);
  const headers = new Headers({
    "content-length": String(copy.byteLength),
    "x-kohaku-public-cache": "hit",
  });
  if (contentType) headers.set("content-type", contentType);
  const res = new Response(copy, { status: 200, statusText: "OK", headers });
  try {
    Object.defineProperty(res, "url", {
      value: requestUrl,
      configurable: true,
      enumerable: true,
    });
  } catch {
    // ignore
  }
  return res;
}

/**
 * Snapshot chunks live under a versioned prefix so publishing a newer set does
 * not break clients pinned to an older manifest. Override with
 * `KOHAKU_SYNC_CACHE_BASE_URL`.
 */
export const DEFAULT_SYNC_CACHE_BASE_URL =
  "https://artifacts.0000000000.org/sync-cache/v1";

/** Chunks are ~8 MiB, but Tor throughput varies wildly; be generous. */
const DEFAULT_CHUNK_TIMEOUT_MS = 300_000;

/**
 * Above the largest observed single compressed entry (~6.6 MiB), so no entry is
 * forced into an oversized chunk of its own.
 */
export const DEFAULT_CHUNK_BYTES = 8 * 1024 * 1024;

export const SYNC_CACHE_MANIFEST_NAME = "manifest.json";
const CHUNK_NAME_RE = /^chunk-\d{3,}\.tar\.gz$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const CACHE_KEY_RE = /^[a-f0-9]{64}$/;

export function resolveSyncCacheBaseUrl(): string {
  const fromEnv = process.env.KOHAKU_SYNC_CACHE_BASE_URL?.trim();
  const url = fromEnv || DEFAULT_SYNC_CACHE_BASE_URL;
  return url.replace(/\/+$/, "");
}

export function syncCacheManifestUrl(): string {
  return `${resolveSyncCacheBaseUrl()}/${SYNC_CACHE_MANIFEST_NAME}`;
}

export function syncCacheChunkUrl(chunkName: string): string {
  if (!CHUNK_NAME_RE.test(chunkName)) {
    throw new Error(`Refusing unsafe chunk name ${JSON.stringify(chunkName)}`);
  }
  return `${resolveSyncCacheBaseUrl()}/${chunkName}`;
}

export function resolveSyncCacheChunkTimeoutMs(): number {
  const raw = process.env.KOHAKU_SYNC_CACHE_CHUNK_TIMEOUT_MS?.trim();
  if (!raw) return DEFAULT_CHUNK_TIMEOUT_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1_000) return DEFAULT_CHUNK_TIMEOUT_MS;
  return Math.floor(n);
}

function cacheEntryKeys(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const keys = new Set<string>();
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".bin")) continue;
    const key = name.slice(0, -".bin".length);
    if (!CACHE_KEY_FILE_RE.test(`${key}.bin`)) continue;
    if (existsSync(metaPath(dir, key))) keys.add(key);
  }
  return [...keys];
}

export function countPublicSyncCacheEntries(
  dataDir: string = activeDataDir
): number {
  return cacheEntryKeys(publicSyncCacheDir(dataDir)).length;
}

function runTar(args: string[]): void {
  const result = spawnSync("tar", args, { encoding: "utf8" });
  if (result.error) {
    throw new Error(
      `tar failed to start (${result.error.message}). Install tar to pack/install public-sync snapshots.`
    );
  }
  if (result.status !== 0) {
    throw new Error(
      `tar ${args[0]} failed: ${(result.stderr || result.stdout || "").trim() || `exit ${result.status}`}`
    );
  }
}

function assertSafeTarListing(archivePath: string): void {
  const result = spawnSync("tar", ["-tzf", archivePath], { encoding: "utf8" });
  if (result.error) {
    throw new Error(
      `tar failed to start (${result.error.message}). Install tar to install public-sync snapshots.`
    );
  }
  if (result.status !== 0) {
    throw new Error(
      `tar list failed: ${(result.stderr || result.stdout || "").trim() || `exit ${result.status}`}`
    );
  }
  for (const line of (result.stdout ?? "").split("\n")) {
    const entry = line.trim();
    if (!entry) continue;
    if (entry.startsWith("/") || entry.includes("..")) {
      throw new Error(
        `Refusing public-sync snapshot with unsafe path ${JSON.stringify(entry)}`
      );
    }
  }
}

function walkFiles(dir: string, acc: string[] = []): string[] {
  if (!existsSync(dir)) return acc;
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, name.name);
    if (name.isDirectory()) walkFiles(full, acc);
    else if (name.isFile()) acc.push(full);
  }
  return acc;
}

export type SyncCacheChunk = {
  name: string;
  bytes: number;
  sha256: string;
  keys: string[];
};

export type SyncCacheManifest = {
  version: 1;
  createdAt: string;
  entries: number;
  rawBytes: number;
  chunks: SyncCacheChunk[];
};

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * Group keys into bins under `chunkBytes` of compressed output. gzip's window is
 * only 32 KiB, so a member's standalone compressed size is a good predictor of
 * its contribution to the chunk. First-fit-decreasing keeps the bins full; an
 * entry larger than the target gets a chunk to itself.
 */
function binPackKeys(
  cacheDir: string,
  keys: string[],
  chunkBytes: number
): string[][] {
  const sized = keys
    .map((key) => ({
      key,
      size:
        gzipSync(readFileSync(bodyPath(cacheDir, key))).byteLength +
        statSync(metaPath(cacheDir, key)).size,
    }))
    .sort((a, b) => b.size - a.size);

  const bins: Array<{ keys: string[]; size: number }> = [];
  for (const { key, size } of sized) {
    const bin = bins.find((b) => b.size + size <= chunkBytes);
    if (bin) {
      bin.keys.push(key);
      bin.size += size;
    } else {
      bins.push({ keys: [key], size });
    }
  }
  return bins.map((b) => b.keys.sort());
}

/**
 * Pack `<dataDir>/public-sync-cache` into independently verifiable `.tar.gz`
 * chunks plus a manifest, so a consumer can fetch, check, and extract them one
 * at a time instead of transferring one large archive.
 */
export function packPublicSyncCacheChunks(opts: {
  dataDir?: string;
  outputDir: string;
  chunkBytes?: number;
}): { outputDir: string; manifest: SyncCacheManifest } {
  const dataDir = opts.dataDir ?? activeDataDir;
  const chunkBytes = opts.chunkBytes ?? DEFAULT_CHUNK_BYTES;
  if (chunkBytes < 1024) {
    throw new Error(`chunkBytes must be at least 1024 (got ${chunkBytes})`);
  }
  const cacheDir = publicSyncCacheDir(dataDir);
  const selected = cacheEntryKeys(cacheDir);
  if (selected.length === 0) {
    throw new Error(`No public-sync-cache entries in ${cacheDir}`);
  }

  mkdirSync(opts.outputDir, { recursive: true });
  const groups = binPackKeys(cacheDir, selected, chunkBytes);
  const chunks: SyncCacheChunk[] = [];
  let rawBytes = 0;

  for (let i = 0; i < groups.length; i++) {
    const keys = groups[i]!;
    const name = `chunk-${String(i).padStart(3, "0")}.tar.gz`;
    const chunkPath = join(opts.outputDir, name);
    const staging = mkdtempSync(join(tmpdir(), "kohaku-sync-cache-pack-"));
    try {
      for (const key of keys) {
        copyFileSync(bodyPath(cacheDir, key), join(staging, `${key}.bin`));
        copyFileSync(metaPath(cacheDir, key), join(staging, `${key}.json`));
        rawBytes +=
          statSync(bodyPath(cacheDir, key)).size +
          statSync(metaPath(cacheDir, key)).size;
      }
      runTar(["-czf", chunkPath, "-C", staging, "."]);
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
    chunks.push({
      name,
      bytes: statSync(chunkPath).size,
      sha256: sha256File(chunkPath),
      keys,
    });
  }

  const manifest: SyncCacheManifest = {
    version: 1,
    createdAt: new Date().toISOString(),
    entries: selected.length,
    rawBytes,
    chunks,
  };
  writeFileSync(
    join(opts.outputDir, SYNC_CACHE_MANIFEST_NAME),
    `${JSON.stringify(manifest, null, 2)}\n`
  );
  return { outputDir: opts.outputDir, manifest };
}

/** Validate an untrusted manifest before acting on any of its chunk names. */
export function parseSyncCacheManifest(raw: string): SyncCacheManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(
      `Sync-cache manifest is not valid JSON: ${e instanceof Error ? e.message : String(e)}`
    );
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Sync-cache manifest must be a JSON object");
  }
  const m = parsed as Record<string, unknown>;
  if (m.version !== 1) {
    throw new Error(
      `Unsupported sync-cache manifest version ${JSON.stringify(m.version)} (expected 1). Upgrade kohaku-cli.`
    );
  }
  if (!Array.isArray(m.chunks) || m.chunks.length === 0) {
    throw new Error("Sync-cache manifest has no chunks");
  }

  const seen = new Set<string>();
  const chunks: SyncCacheChunk[] = m.chunks.map((entry, i) => {
    if (!entry || typeof entry !== "object") {
      throw new Error(`Sync-cache manifest chunk ${i} is not an object`);
    }
    const c = entry as Record<string, unknown>;
    const name = c.name;
    if (typeof name !== "string" || !CHUNK_NAME_RE.test(name)) {
      throw new Error(
        `Refusing unsafe chunk name ${JSON.stringify(name)} in sync-cache manifest`
      );
    }
    if (seen.has(name)) {
      throw new Error(`Duplicate chunk ${name} in sync-cache manifest`);
    }
    seen.add(name);
    if (typeof c.sha256 !== "string" || !SHA256_RE.test(c.sha256)) {
      throw new Error(`Chunk ${name} has no valid sha256 in sync-cache manifest`);
    }
    if (typeof c.bytes !== "number" || !Number.isInteger(c.bytes) || c.bytes <= 0) {
      throw new Error(`Chunk ${name} has no valid byte size in sync-cache manifest`);
    }
    if (!Array.isArray(c.keys) || c.keys.length === 0) {
      throw new Error(`Chunk ${name} lists no cache keys in sync-cache manifest`);
    }
    const keys = c.keys.map((k) => {
      if (typeof k !== "string" || !CACHE_KEY_RE.test(k)) {
        throw new Error(
          `Chunk ${name} lists invalid cache key ${JSON.stringify(k)}`
        );
      }
      return k;
    });
    return { name, bytes: c.bytes, sha256: c.sha256, keys };
  });

  return {
    version: 1,
    createdAt: typeof m.createdAt === "string" ? m.createdAt : "",
    entries:
      typeof m.entries === "number" && Number.isInteger(m.entries)
        ? m.entries
        : chunks.reduce((n, c) => n + c.keys.length, 0),
    rawBytes: typeof m.rawBytes === "number" ? m.rawBytes : 0,
    chunks,
  };
}

/** True when every key already has both an on-disk body and metadata file. */
export function publicSyncCacheHasAllKeys(
  keys: string[],
  dataDir: string = activeDataDir
): boolean {
  const dir = publicSyncCacheDir(dataDir);
  return keys.every(
    (key) => existsSync(bodyPath(dir, key)) && existsSync(metaPath(dir, key))
  );
}

/**
 * Verify a downloaded chunk against its manifest entry, then merge it into the
 * cache. Rejects the chunk rather than installing partial data on mismatch.
 */
export function installPublicSyncCacheChunk(opts: {
  dataDir?: string;
  archivePath: string;
  chunk: SyncCacheChunk;
}): { installed: number; cacheDir: string } {
  const { archivePath, chunk } = opts;
  if (!existsSync(archivePath)) {
    throw new Error(`Chunk archive not found: ${archivePath}`);
  }
  const actualBytes = statSync(archivePath).size;
  if (actualBytes !== chunk.bytes) {
    throw new Error(
      `Chunk ${chunk.name} size mismatch: expected ${chunk.bytes} bytes, got ${actualBytes}`
    );
  }
  const actualSha = sha256File(archivePath);
  if (actualSha !== chunk.sha256) {
    throw new Error(
      `Chunk ${chunk.name} sha256 mismatch: expected ${chunk.sha256}, got ${actualSha}`
    );
  }
  return installPublicSyncCacheArchive({
    dataDir: opts.dataDir,
    archivePath,
  });
}

/**
 * Extract a snapshot tarball into `<dataDir>/public-sync-cache` (merge;
 * existing keys are overwritten).
 */
export function installPublicSyncCacheArchive(opts: {
  dataDir?: string;
  archivePath: string;
}): { installed: number; cacheDir: string } {
  const dataDir = opts.dataDir ?? activeDataDir;
  const cacheDir = publicSyncCacheDir(dataDir);
  if (!existsSync(opts.archivePath)) {
    throw new Error(`Snapshot archive not found: ${opts.archivePath}`);
  }
  assertSafeTarListing(opts.archivePath);

  const staging = mkdtempSync(join(tmpdir(), "kohaku-public-sync-unpack-"));
  try {
    runTar(["-xzf", opts.archivePath, "-C", staging]);
    mkdirSync(cacheDir, { recursive: true });
    let installed = 0;
    for (const file of walkFiles(staging)) {
      const name = basename(file);
      if (!CACHE_KEY_FILE_RE.test(name)) continue;
      copyFileSync(file, join(cacheDir, name));
      if (name.endsWith(".bin")) installed += 1;
    }
    if (installed === 0) {
      throw new Error(
        `No public-sync-cache entries found in ${opts.archivePath}`
      );
    }
    return { installed, cacheDir };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
