import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

import {
  hasLocalSyncCacheV2File,
  localSyncCacheV2Manifest,
  syncCacheV2ObjectPath,
  type SyncCacheV2Manifest,
} from "./sync-cache-v2.js";

export const PPOI_MAINNET_ENDPOINT = "https://ppoi.fdi.network/";
export const PPOI_LEAF_PAGE = 100;
export const PPOI_SEGMENT_LEAVES = 20_000;
export const PPOI_ZERO_LEAF = "0488f89b25bc7011eaf6a5edce71aeafb9fe706faa3c0a5cd9cbe868ae3b9ffc";

type Segment = { fromIndex: number; toIndexExclusive: number; file: string };
type Index = {
  schema: "kohaku-railgun-ppoi-v1";
  chainId: 1;
  endpoint: string;
  listKey: string;
  txidVersion: "V2_PoseidonMerkle";
  pageSize: 100;
  throughLeafExclusive: number;
  segments: Segment[];
};

const LEAF_HEX = /^(?:0x)?[0-9a-fA-F]{1,64}$/;
const LIST_KEY = /^[0-9a-fA-F]{64}$/;
const decoded = new Map<string, string[]>();

function validIndex(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function loadIndex(manifest: SyncCacheV2Manifest): Index | null {
  const prefix = manifest.sources.ppoiMainnet;
  if (!prefix) return null;
  const indexFile = manifest.files.find((file) => file.path === `${prefix}/index.json`);
  if (!indexFile || !hasLocalSyncCacheV2File(indexFile)) return null;
  let index: Index;
  try {
    index = JSON.parse(readFileSync(syncCacheV2ObjectPath(indexFile), "utf8")) as Index;
  } catch {
    return null;
  }
  if (index.schema !== "kohaku-railgun-ppoi-v1" || index.chainId !== 1 ||
      index.endpoint !== PPOI_MAINNET_ENDPOINT || !LIST_KEY.test(index.listKey) ||
      index.txidVersion !== "V2_PoseidonMerkle" || index.pageSize !== PPOI_LEAF_PAGE ||
      !validIndex(index.throughLeafExclusive) || index.throughLeafExclusive === 0 ||
      index.throughLeafExclusive % PPOI_LEAF_PAGE !== 0 || !Array.isArray(index.segments)) return null;
  let next = 0;
  for (const segment of index.segments) {
    if (!validIndex(segment.fromIndex) || segment.fromIndex !== next ||
        !validIndex(segment.toIndexExclusive) || segment.toIndexExclusive <= next ||
        segment.toIndexExclusive - next > PPOI_SEGMENT_LEAVES ||
        segment.toIndexExclusive % PPOI_LEAF_PAGE !== 0 ||
        segment.file !== `leaves-${next}-${segment.toIndexExclusive}.json.gz` ||
        !manifest.files.some((file) => file.path === `${prefix}/${segment.file}`)) return null;
    next = segment.toIndexExclusive;
  }
  return next === index.throughLeafExclusive ? index : null;
}

function readLeaves(manifest: SyncCacheV2Manifest, prefix: string, segment: Segment): string[] | null {
  const file = manifest.files.find((entry) => entry.path === `${prefix}/${segment.file}`);
  if (!file || !hasLocalSyncCacheV2File(file)) return null;
  const cached = decoded.get(file.sha256);
  if (cached) return cached;
  try {
    const raw = gunzipSync(readFileSync(syncCacheV2ObjectPath(file)), { maxOutputLength: 4 * 1024 * 1024 });
    const leaves: unknown = JSON.parse(raw.toString("utf8"));
    if (!Array.isArray(leaves) || leaves.length !== segment.toIndexExclusive - segment.fromIndex ||
        !leaves.every((leaf) => typeof leaf === "string" && LEAF_HEX.test(leaf) &&
          leaf.replace(/^0x/, "").padStart(64, "0").toLowerCase() !== PPOI_ZERO_LEAF)) return null;
    // Keep a few decoded segments across consecutive page requests.
    if (decoded.size >= 4) decoded.delete(decoded.keys().next().value!);
    decoded.set(file.sha256, leaves as string[]);
    return leaves as string[];
  } catch {
    return null;
  }
}

/** Answer only complete historical leaf pages. Live PPOI still validates every batch's roots. */
export function ppoiSyncSnapshotResponse(url: string, method: string, body: Uint8Array): Response | null {
  if (method !== "POST" || url !== PPOI_MAINNET_ENDPOINT) return null;
  const manifest = localSyncCacheV2Manifest();
  const prefix = manifest?.sources.ppoiMainnet;
  if (!manifest || !prefix) return null;
  const index = loadIndex(manifest);
  if (!index) return null;
  let request: { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: Record<string, unknown> };
  try {
    request = JSON.parse(Buffer.from(body).toString("utf8")) as typeof request;
  } catch {
    return null;
  }
  const params = request.params;
  if (request.jsonrpc !== "2.0" || !validIndex(request.id) ||
      request.method !== "ppoi_poi_merkletree_leaves" || !params ||
      params.chainType !== "0" || params.chainID !== "1" ||
      params.txidVersion !== index.txidVersion || params.listKey !== index.listKey) return null;
  const from = params.startIndex;
  const to = params.endIndex;
  if (!validIndex(from) || !validIndex(to) || to - from !== PPOI_LEAF_PAGE ||
      from % PPOI_LEAF_PAGE !== 0 || to > index.throughLeafExclusive) return null;
  const segment = index.segments.find((entry) => entry.fromIndex <= from && to <= entry.toIndexExclusive);
  if (!segment) return null;
  const leaves = readLeaves(manifest, prefix, segment);
  if (!leaves) return null;
  const result = leaves.slice(from - segment.fromIndex, to - segment.fromIndex);
  if (result.length !== PPOI_LEAF_PAGE) return null;
  const response = new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }), {
    status: 200,
    headers: { "content-type": "application/json", "x-kohaku-public-cache": "v2-ppoi-hit" },
  });
  Object.defineProperty(response, "url", { value: url, configurable: true });
  return response;
}
