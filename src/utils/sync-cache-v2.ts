import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { open, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

import { getPublicSyncCacheDataDir } from "./public-sync-cache.js";

export const SYNC_CACHE_V2_BASE_URL = "https://artifacts.0000000000.org/sync-cache/v2";
export const SYNC_CACHE_V2_MANIFEST = "manifest.json";
const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_PATH = /^[a-zA-Z0-9._/-]+$/;
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const MAX_FILE_BYTES = 256 * 1024 * 1024;

export type SyncCacheV2File = {
  path: string;
  bytes: number;
  sha256: string;
};

export type SyncCacheV2Manifest = {
  version: 2;
  createdAt: string;
  release: string;
  files: SyncCacheV2File[];
  sources: {
    sagaMainnet?: string;
    railgunMainnet?: string;
    ppoiMainnet?: string;
  };
};

export function syncCacheV2Dir(dataDir = getPublicSyncCacheDataDir()): string {
  return join(dataDir, "sync-cache-v2");
}

export function syncCacheV2BaseUrl(): string {
  return (process.env.KOHAKU_SYNC_CACHE_BASE_URL?.trim() || SYNC_CACHE_V2_BASE_URL)
    .replace(/\/+$/, "");
}

export function syncCacheV2Url(path: string): string {
  assertSafePath(path);
  return `${syncCacheV2BaseUrl()}/${path}`;
}

function assertSafePath(path: string): void {
  if (!SAFE_PATH.test(path) || path.startsWith("/") || path.endsWith("/") ||
      path.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`Unsafe sync-cache v2 path: ${JSON.stringify(path)}`);
  }
}

export function parseSyncCacheV2Manifest(raw: string): SyncCacheV2Manifest {
  if (Buffer.byteLength(raw) > MAX_MANIFEST_BYTES) throw new Error("Sync-cache v2 manifest is too large");
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object") throw new Error("Sync-cache v2 manifest must be an object");
  const m = value as Record<string, unknown>;
  if (m.version !== 2) throw new Error(`Unsupported sync-cache version ${String(m.version)}`);
  if (typeof m.release !== "string" || !/^[a-zA-Z0-9._-]+$/.test(m.release)) {
    throw new Error("Sync-cache v2 manifest has an invalid release ID");
  }
  if (typeof m.createdAt !== "string" || !Number.isFinite(Date.parse(m.createdAt))) {
    throw new Error("Sync-cache v2 manifest has an invalid creation date");
  }
  if (!Array.isArray(m.files) || m.files.length === 0) {
    throw new Error("Sync-cache v2 manifest has no files");
  }
  const seen = new Set<string>();
  const files = m.files.map((rawFile) => {
    if (!rawFile || typeof rawFile !== "object") throw new Error("Invalid sync-cache v2 file");
    const file = rawFile as Record<string, unknown>;
    if (typeof file.path !== "string") throw new Error("Sync-cache v2 file has no path");
    const path = file.path;
    assertSafePath(path);
    if (!["saga/", "railgun/", "ppoi/"].some((prefix) => path.startsWith(prefix))) {
      throw new Error(`Sync-cache v2 file is outside the protocol directories: ${path}`);
    }
    if (seen.has(file.path)) throw new Error(`Duplicate sync-cache v2 file ${file.path}`);
    seen.add(file.path);
    if (typeof file.bytes !== "number" || !Number.isSafeInteger(file.bytes) || file.bytes <= 0 || file.bytes > MAX_FILE_BYTES) {
      throw new Error(`Invalid byte size for ${file.path}`);
    }
    if (typeof file.sha256 !== "string" || !SHA256.test(file.sha256)) {
      throw new Error(`Invalid SHA-256 for ${file.path}`);
    }
    return { path: file.path, bytes: file.bytes, sha256: file.sha256 } as SyncCacheV2File;
  });
  if (!m.sources || typeof m.sources !== "object") {
    throw new Error("Sync-cache v2 manifest has no sources");
  }
  const sourceValues = m.sources as Record<string, unknown>;
  const sources: SyncCacheV2Manifest["sources"] = {};
  for (const name of ["sagaMainnet", "railgunMainnet", "ppoiMainnet"] as const) {
    const prefix = sourceValues[name];
    if (prefix === undefined) continue;
    if (typeof prefix !== "string") throw new Error(`Invalid ${name} source`);
    assertSafePath(prefix);
    const expected = name === "sagaMainnet" ? "saga" : name === "railgunMainnet" ? "railgun" : "ppoi";
    if (prefix !== expected || !seen.has(`${prefix}/index.json`)) {
      throw new Error(`Source ${name} has no index.json in this release`);
    }
    sources[name] = prefix;
  }
  return { version: 2, createdAt: m.createdAt, release: m.release, files, sources };
}

export function localSyncCacheV2Manifest(dataDir?: string): SyncCacheV2Manifest | null {
  try {
    return parseSyncCacheV2Manifest(readFileSync(join(syncCacheV2Dir(dataDir), SYNC_CACHE_V2_MANIFEST), "utf8"));
  } catch {
    return null;
  }
}

export function localSyncCacheV2Source(name: keyof SyncCacheV2Manifest["sources"], dataDir?: string): string | null {
  const manifest = localSyncCacheV2Manifest(dataDir);
  const source = manifest?.sources[name];
  if (!source) return null;
  const index = manifest?.files.find((file) => file.path === `${source}/index.json`);
  return index && hasLocalSyncCacheV2File(index, dataDir) ? syncCacheV2Url(source) : null;
}

function sha256Buffer(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Immutable local object storage lets an active manifest survive a later root-layout download. */
export function syncCacheV2ObjectPath(file: SyncCacheV2File, dataDir?: string): string {
  return join(syncCacheV2Dir(dataDir), "objects", file.sha256);
}

export function hasLocalSyncCacheV2File(file: SyncCacheV2File, dataDir?: string): boolean {
  const path = syncCacheV2ObjectPath(file, dataDir);
  try {
    return statSync(path).size === file.bytes && sha256Buffer(readFileSync(path)) === file.sha256;
  } catch {
    return false;
  }
}

/** Only files listed in the installed manifest are served from disk. */
export function localSyncCacheV2Response(url: string, dataDir?: string): Response | null {
  const base = syncCacheV2BaseUrl();
  if (!url.startsWith(`${base}/`)) return null;
  const relative = url.slice(base.length + 1);
  if (relative === SYNC_CACHE_V2_MANIFEST || relative.includes("?") || relative.includes("#")) return null;
  const file = localSyncCacheV2Manifest(dataDir)?.files.find((item) => item.path === relative);
  if (!file || !hasLocalSyncCacheV2File(file, dataDir)) return null;
  const bytes = readFileSync(syncCacheV2ObjectPath(file, dataDir));
  const response = new Response(Uint8Array.from(bytes), {
    status: 200,
    headers: {
      "content-length": String(bytes.length),
      "content-type": relative.endsWith(".gz") ? "application/gzip" : "application/json",
      "x-kohaku-public-cache": "v2-hit",
    },
  });
  Object.defineProperty(response, "url", { value: url, configurable: true });
  return response;
}

/** Stream a file over Tor or clearnet, verify it, then atomically install it. */
export async function downloadSyncCacheV2File(file: SyncCacheV2File, opts: {
  dataDir?: string;
  force?: boolean;
  timeoutMs?: number;
} = {}): Promise<"installed" | "skipped"> {
  if (!opts.force && hasLocalSyncCacheV2File(file, opts.dataDir)) return "skipped";
  const destination = syncCacheV2ObjectPath(file, opts.dataDir);
  const temp = `${destination}.partial-${process.pid}-${Math.random().toString(16).slice(2)}`;
  mkdirSync(dirname(destination), { recursive: true });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 300_000);
  let bytes = 0;
  const digest = createHash("sha256");
  try {
    const response = await fetch(syncCacheV2Url(file.path), {
      signal: controller.signal,
      headers: { "x-kohaku-sync-cache-refresh": "1" },
    });
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status} for ${file.path}`);
    const handle = await open(temp, "w");
    try {
      const reader = response.body.getReader();
      while (true) {
        const { done, value: chunk } = await reader.read();
        if (done) break;
        bytes += chunk.byteLength;
        if (bytes > file.bytes) throw new Error(`File exceeds advertised size: ${file.path}`);
        digest.update(chunk);
        let offset = 0;
        while (offset < chunk.byteLength) {
          const result = await handle.write(chunk, offset, chunk.byteLength - offset);
          if (result.bytesWritten === 0) throw new Error(`Short write: ${file.path}`);
          offset += result.bytesWritten;
        }
      }
    } finally {
      await handle.close();
    }
    if (bytes !== file.bytes) throw new Error(`Size mismatch for ${file.path}: expected ${file.bytes}, got ${bytes}`);
    if (digest.digest("hex") !== file.sha256) throw new Error(`SHA-256 mismatch for ${file.path}`);
    renameSync(temp, destination);
    return "installed";
  } finally {
    clearTimeout(timer);
    if (existsSync(temp)) await unlink(temp);
  }
}

export function installSyncCacheV2Manifest(raw: string, dataDir?: string): SyncCacheV2Manifest {
  const manifest = parseSyncCacheV2Manifest(raw);
  if (!manifest.files.every((file) => hasLocalSyncCacheV2File(file, dataDir))) {
    throw new Error("Cannot activate an incomplete sync-cache v2 release");
  }
  const dir = syncCacheV2Dir(dataDir);
  mkdirSync(dir, { recursive: true });
  const temp = join(dir, `${SYNC_CACHE_V2_MANIFEST}.partial-${process.pid}-${Math.random().toString(16).slice(2)}`);
  writeFileSync(temp, raw);
  renameSync(temp, join(dir, SYNC_CACHE_V2_MANIFEST));
  return manifest;
}
