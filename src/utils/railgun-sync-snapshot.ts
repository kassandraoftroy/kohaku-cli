import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

import {
  hasLocalSyncCacheV2File,
  localSyncCacheV2Manifest,
  syncCacheV2ObjectPath,
  type SyncCacheV2Manifest,
} from "./sync-cache-v2.js";

type Kind = "commitments" | "nullifiers" | "operations";
type Row = { id: string; blockNumber: string } & Record<string, unknown>;
type Segment = { fromBlock: number; toBlock: number; file: string; count: number };
type Index = {
  schema: "kohaku-railgun-subsquid-v1";
  chainId: 1;
  endpoint: string;
  fromBlock: number;
  throughBlock: number;
  querySha256: Record<Kind, string>;
  segments: Record<Kind, Segment[]>;
};

const MAX_DECODED_CACHE_BYTES = 96 * 1024 * 1024;
const decoded = new Map<string, { rows: Row[]; bytes: number }>();
let decodedBytes = 0;

function sha256(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function validInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function loadIndex(manifest: SyncCacheV2Manifest): Index | null {
  const prefix = manifest.sources.railgunMainnet;
  if (!prefix) return null;
  const relative = `${prefix}/index.json`;
  const file = manifest.files.find((entry) => entry.path === relative);
  if (!file || !hasLocalSyncCacheV2File(file)) return null;
  let index: Index;
  try {
    index = JSON.parse(readFileSync(syncCacheV2ObjectPath(file), "utf8")) as Index;
  } catch {
    return null;
  }
  if (index.schema !== "kohaku-railgun-subsquid-v1" || index.chainId !== 1 ||
      !validInteger(index.fromBlock) || !validInteger(index.throughBlock) ||
      index.throughBlock < index.fromBlock || typeof index.endpoint !== "string" ||
      !index.querySha256 || !index.segments) return null;
  for (const kind of ["commitments", "nullifiers", "operations"] as Kind[]) {
    if (!/^[a-f0-9]{64}$/.test(index.querySha256[kind] ?? "")) return null;
    const segments = index.segments[kind];
    if (!Array.isArray(segments) || segments.length === 0) return null;
    let next = index.fromBlock;
    for (const segment of segments) {
      if (segment.fromBlock !== next || !validInteger(segment.toBlock) || segment.toBlock < next ||
          !validInteger(segment.count) || !/^[a-z]+-[0-9]+-[0-9]+\.json\.gz$/.test(segment.file) ||
          !manifest.files.some((entry) => entry.path === `${prefix}/${segment.file}`)) return null;
      next = segment.toBlock + 1;
    }
    if (next !== index.throughBlock + 1) return null;
  }
  return index;
}

function readRows(manifest: SyncCacheV2Manifest, relative: string): Row[] {
  const file = manifest.files.find((entry) => entry.path === relative);
  if (!file) throw new Error(`Missing Railgun snapshot segment: ${relative}`);
  const cached = decoded.get(file.sha256);
  if (cached) {
    decoded.delete(file.sha256);
    decoded.set(file.sha256, cached);
    return cached.rows;
  }
  if (!hasLocalSyncCacheV2File(file)) throw new Error(`Missing Railgun snapshot segment: ${relative}`);
  const raw = gunzipSync(readFileSync(syncCacheV2ObjectPath(file)));
  const rows = JSON.parse(raw.toString("utf8")) as Row[];
  if (!Array.isArray(rows)) throw new Error(`Invalid Railgun snapshot segment: ${relative}`);
  const bytes = raw.byteLength;
  while (decodedBytes + bytes > MAX_DECODED_CACHE_BYTES && decoded.size > 0) {
    const oldest = decoded.keys().next().value as string;
    decodedBytes -= decoded.get(oldest)!.bytes;
    decoded.delete(oldest);
  }
  if (bytes <= MAX_DECODED_CACHE_BYTES) {
    decoded.set(file.sha256, { rows, bytes });
    decodedBytes += bytes;
  }
  return rows;
}

/** Answer only known, bounded mainnet queries. Everything else uses live Subsquid. */
export function railgunSyncSnapshotResponse(url: string, method: string, body: Uint8Array): Response | null {
  if (method !== "POST") return null;
  const manifest = localSyncCacheV2Manifest();
  if (!manifest?.sources.railgunMainnet) return null;
  const index = loadIndex(manifest);
  if (!index || url !== index.endpoint) return null;
  let request: { query?: unknown; variables?: Record<string, unknown> };
  try {
    request = JSON.parse(Buffer.from(body).toString("utf8")) as typeof request;
  } catch {
    return null;
  }
  if (typeof request.query !== "string" || !request.variables) return null;
  const queryHash = sha256(request.query);
  const kind = (["commitments", "nullifiers", "operations"] as Kind[])
    .find((candidate) => index.querySha256[candidate] === queryHash);
  if (!kind) return null;
  const variables = request.variables;
  const from = Number(variables.blockNumber_gte);
  const to = Number(variables.blockNumber_lte);
  const limit = Number(variables.limit);
  const idGt = variables.id_gt;
  if (!validInteger(from) || !validInteger(to) || from < index.fromBlock ||
      to > index.throughBlock || from > to || !validInteger(limit) || limit < 1 ||
      limit > 100_000 || typeof idGt !== "string") return null;

  try {
    const rows: Row[] = [];
    for (const segment of index.segments[kind]) {
      if (segment.toBlock < from || segment.fromBlock > to) continue;
      for (const row of readRows(manifest, `${manifest.sources.railgunMainnet}/${segment.file}`)) {
        const block = Number(row.blockNumber);
        if (block >= from && block <= to && row.id > idGt) rows.push(row);
      }
    }
    rows.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    const field = kind === "operations" ? "transactions" : kind;
    const response = new Response(JSON.stringify({ data: { [field]: rows.slice(0, limit) } }), {
      status: 200,
      headers: { "content-type": "application/json", "x-kohaku-public-cache": "v2-railgun-hit" },
    });
    Object.defineProperty(response, "url", { value: url, configurable: true });
    return response;
  } catch {
    return null;
  }
}
