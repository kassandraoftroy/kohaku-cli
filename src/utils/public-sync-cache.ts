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
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { categorizeUrl } from "./network-traffic-log.js";

const DEFAULT_MAX_BYTES = 1 * 1024 * 1024 * 1024;
const DEFAULT_MAX_ENTRY_BYTES = 50 * 1024 * 1024;

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

function evictIfNeeded(dir: string, incomingBytes: number): void {
  const max = maxCacheBytes();
  type Entry = { key: string; mtime: number; size: number };
  const entries: Entry[] = [];
  let total = 0;
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".bin")) continue;
    const key = name.slice(0, -".bin".length);
    const bin = bodyPath(dir, key);
    const meta = metaPath(dir, key);
    try {
      const st = statSync(bin);
      total += st.size;
      entries.push({ key, mtime: st.mtimeMs, size: st.size });
      if (existsSync(meta)) total += statSync(meta).size;
    } catch {
      // ignore unreadable entries
    }
  }
  if (total + incomingBytes <= max) return;
  entries.sort((a, b) => a.mtime - b.mtime);
  for (const e of entries) {
    if (total + incomingBytes <= max) break;
    try {
      unlinkSync(bodyPath(dir, e.key));
    } catch {
      // ignore
    }
    try {
      unlinkSync(metaPath(dir, e.key));
    } catch {
      // ignore
    }
    total -= e.size;
  }
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
  mkdirSync(dir, { recursive: true });
  evictIfNeeded(dir, responseBody.byteLength);

  const key = publicSyncCacheKey(opts.method, opts.url, opts.body ?? "");
  const meta: CacheMeta = {
    url: opts.url,
    method: opts.method.toUpperCase(),
    contentType: opts.contentType ?? null,
    storedAt: new Date().toISOString(),
    bytes: responseBody.byteLength,
  };
  writeFileSync(bodyPath(dir, key), responseBody);
  writeFileSync(metaPath(dir, key), JSON.stringify(meta));
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
 * Placeholder file until a real snapshot is published. Override with
 * `KOHAKU_PUBLIC_SYNC_SNAPSHOT_URL`.
 */
export const DEFAULT_PUBLIC_SYNC_SNAPSHOT_URL =
  "https://artifacts.0000000000.org/public-sync-cache.tar.gz";

const CACHE_KEY_FILE_RE = /^[a-f0-9]{64}\.(bin|json)$/;

export function resolvePublicSyncSnapshotUrl(): string {
  const fromEnv = process.env.KOHAKU_PUBLIC_SYNC_SNAPSHOT_URL?.trim();
  const url = fromEnv || DEFAULT_PUBLIC_SYNC_SNAPSHOT_URL;
  return url.replace(/\/+$/, "");
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

/** Pack the whole `<dataDir>/public-sync-cache` into a `.tar.gz`. */
export function packPublicSyncCacheArchive(opts: {
  dataDir?: string;
  outputPath: string;
}): { outputPath: string; entries: number } {
  const dataDir = opts.dataDir ?? activeDataDir;
  const cacheDir = publicSyncCacheDir(dataDir);
  const selected = cacheEntryKeys(cacheDir);
  if (selected.length === 0) {
    throw new Error(`No public-sync-cache entries in ${cacheDir}`);
  }

  const staging = mkdtempSync(join(tmpdir(), "kohaku-public-sync-pack-"));
  try {
    for (const key of selected) {
      copyFileSync(bodyPath(cacheDir, key), join(staging, `${key}.bin`));
      copyFileSync(metaPath(cacheDir, key), join(staging, `${key}.json`));
    }
    mkdirSync(dirname(opts.outputPath), { recursive: true });
    runTar(["-czf", opts.outputPath, "-C", staging, "."]);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  return {
    outputPath: opts.outputPath,
    entries: selected.length,
  };
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
