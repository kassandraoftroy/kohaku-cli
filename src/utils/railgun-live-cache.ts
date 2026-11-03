import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { gzip, gunzip } from "node:zlib";
import { fileFingerprint } from "./file-fingerprint.js";
import { PPOI_MAINNET_ENDPOINT, PPOI_ZERO_LEAF } from "./ppoi-sync-snapshot.js";
import { syncCacheV2Dir } from "./sync-cache-v2.js";

const INDEXER = "https://rail-squid.squids.live/squid-railgun-ethereum-v2/v/v1/graphql";
// Exact public queries shipped by the pinned Railgun WASM. Unknown schemas fail live.
const QUERY_FIELDS: Record<string, string> = {
  e96cccb3d8cbdf15bee6bda83488230492c28b736c4dcc797ae21c70d97da4be: "commitments",
  "91aa3e29c37dcf2593cb3089331c54b7f352ea60d5061d3cc046fad4193a9b5a": "nullifiers",
  "91d581356a0bf6f5c3215ca6822942c1319849452ef068d2566edafb23ae4165": "transactions",
};
const HEAD_QUERY = "4875d123fe37c7ec9c4b1860236d12b29e14cceb327bd526a8d8e8f1a2234f7b";
const MAX_ENTRY = 8 * 1024 * 1024;
const MAX_DISK = 256 * 1024 * 1024;
const compress = promisify(gzip);
const decompress = promisify(gunzip);
const usage = new Map<string, { fingerprint: string | null; bytes: number }>();
let observedIndexerHead: number | undefined;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const integer = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
type Request = { kind: "ppoi"; key: string; id: unknown } |
  { kind: "indexer"; key: string; field: string; from: number; to: number; limit: number; idGt: string };

function parse(body: Uint8Array): any {
  try { return JSON.parse(Buffer.from(body).toString("utf8")); } catch { return null; }
}

function request(url: string, body: Uint8Array): Request | null {
  const value = parse(body);
  if (!value || typeof value !== "object") return null;
  if (url === PPOI_MAINNET_ENDPOINT && value.jsonrpc === "2.0" &&
      value.method === "ppoi_poi_merkletree_leaves") {
    const p = value.params;
    if (!p || p.chainID !== "1" || p.chainType !== "0" || p.txidVersion !== "V2_PoseidonMerkle" ||
        typeof p.listKey !== "string" || !/^[a-f0-9]{64}$/.test(p.listKey) ||
        !integer(p.startIndex) || !integer(p.endIndex) || p.startIndex % 100 || p.endIndex - p.startIndex !== 100 ||
        !(integer(value.id) || typeof value.id === "string")) return null;
    return { kind: "ppoi", id: value.id, key: hash(JSON.stringify([url, p.listKey, p.startIndex, p.endIndex])) };
  }
  if (url !== INDEXER || typeof value.query !== "string") return null;
  const field = QUERY_FIELDS[hash(value.query)];
  const v = value.variables;
  if (!field || !v || Object.keys(v).some((key) => !["blockNumber_gte", "blockNumber_lte", "id_gt", "limit"].includes(key)) ||
      !integer(v.blockNumber_gte) || !integer(v.blockNumber_lte) || v.blockNumber_lte < v.blockNumber_gte ||
      !integer(v.limit) || v.limit < 1 || v.limit > 100000 || typeof v.id_gt !== "string") return null;
  return { kind: "indexer", field, from: v.blockNumber_gte, to: v.blockNumber_lte, limit: v.limit, idGt: v.id_gt,
    key: hash(JSON.stringify([url, field, v.blockNumber_gte, v.blockNumber_lte, v.id_gt, v.limit])) };
}

function validData(req: Request, data: any): boolean {
  if (req.kind === "ppoi") return Array.isArray(data) && data.length === 100 && data.every((leaf) =>
    typeof leaf === "string" && /^(?:0x)?[a-fA-F0-9]{1,64}$/.test(leaf) &&
    leaf.replace(/^0x/, "").padStart(64, "0").toLowerCase() !== PPOI_ZERO_LEAF);
  const rows = data?.[req.field];
  return Array.isArray(rows) && rows.length <= req.limit && rows.every((row, i) =>
    row && typeof row.id === "string" && row.id > req.idGt &&
    (i === 0 || row.id > rows[i - 1].id) && integer(Number(row.blockNumber)) &&
    Number(row.blockNumber) >= req.from && Number(row.blockNumber) <= req.to);
}

/** Shared public data only. Membership, roots, submissions and indexer heads are never served here. */
export async function railgunLiveCacheResponse(url: string, body: Uint8Array): Promise<Response | null> {
  const req = request(url, body);
  if (!req) return null;
  try {
    const path = join(syncCacheV2Dir(), "live", `${req.key}.json.gz`);
    if (statSync(path).size > MAX_ENTRY) return null;
    const raw = await decompress(readFileSync(path), { maxOutputLength: MAX_ENTRY });
    const entry = JSON.parse(raw.toString("utf8"));
    if (entry.version !== 1 || !validData(req, entry.data)) return null;
    const response = Response.json(req.kind === "ppoi"
      ? { jsonrpc: "2.0", id: req.id, result: entry.data } : { data: entry.data },
    { headers: { "x-kohaku-public-cache": "v2-live-hit" } });
    Object.defineProperty(response, "url", { value: url, configurable: true });
    return response;
  } catch { return null; }
}

function diskBytes(dir: string): number {
  const fingerprint = fileFingerprint(dir);
  const cached = usage.get(dir);
  if (cached?.fingerprint === fingerprint) return cached.bytes;
  let bytes = 0;
  try {
    for (const name of readdirSync(dir)) {
      if (/^[a-f0-9]{64}\.json\.gz$/.test(name)) bytes += statSync(join(dir, name)).size;
    }
  } catch { /* A missing cache has no entries. */ }
  if (usage.size >= 16) usage.delete(usage.keys().next().value!);
  usage.set(dir, { fingerprint, bytes });
  return bytes;
}

/** Called only for network responses. Fully populated PPOI pages are append-only;
 * indexer ranges must be at least 128 blocks behind a live observed indexer head. */
export async function cacheRailgunLiveResponse(url: string, body: Uint8Array, response: Response): Promise<void> {
  if (response.status !== 200) return;
  const value = parse(body);
  const isHead = url === INDEXER && typeof value?.query === "string" && hash(value.query) === HEAD_QUERY;
  const req = request(url, body);
  if (!isHead && !req) return;
  if (Number(response.headers.get("content-length")) > MAX_ENTRY) return;
  const reader = response.clone().body?.getReader();
  if (!reader) return;
  try {
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value: chunk } = await reader.read();
      if (done) break;
      size += chunk.byteLength;
      if (size > MAX_ENTRY) { void reader.cancel().catch(() => {}); return; }
      chunks.push(chunk);
    }
    const result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (isHead) {
      const block = Number(result.data?.transactions?.[0]?.blockNumber);
      if (!result.errors && integer(block)) observedIndexerHead = block;
      return;
    }
    if (!req || result.error || result.errors || (req.kind === "ppoi" &&
        (result.jsonrpc !== "2.0" || result.id !== req.id))) return;
    if (req.kind === "indexer" && (observedIndexerHead === undefined || req.to > observedIndexerHead - 128)) return;
    const data = req.kind === "ppoi" ? result.result : result.data;
    if (!validData(req, data)) return;
    const bytes = await compress(JSON.stringify({ version: 1, data }));
    const dir = join(syncCacheV2Dir(), "live");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${req.key}.json.gz`);
    let previous = 0;
    try { previous = statSync(path).size; } catch { /* new page */ }
    const total = diskBytes(dir) - previous + bytes.byteLength;
    if (total > MAX_DISK) return;
    const temp = `${path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temp, bytes, { flag: "wx", mode: 0o600 });
      renameSync(temp, path);
      usage.set(dir, { fingerprint: fileFingerprint(dir), bytes: total });
    } finally {
      try { unlinkSync(temp); } catch { /* already renamed */ }
    }
  } catch { /* A disposable public cache never makes a network request fail. */ }
}
