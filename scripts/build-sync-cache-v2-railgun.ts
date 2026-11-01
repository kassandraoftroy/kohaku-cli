/**
 * Build mainnet Railgun's public Subsquid snapshot after the Saga builder.
 * This reads the GraphQL queries from the exact kohaku-rs source used by the
 * pinned WASM wrapper, so the runtime can reject an incompatible query shape.
 *
 * npx tsx scripts/build-sync-cache-v2-railgun.ts <output-dir> <release-id> [kohaku-rs-dir]
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";

import { parseSyncCacheV2Manifest, type SyncCacheV2File, type SyncCacheV2Manifest } from "../src/utils/sync-cache-v2.js";

const ENDPOINT = "https://rail-squid.squids.live/squid-railgun-ethereum-v2/v/v1/graphql";
const DEPLOYMENT_BLOCK = 14_693_013;
const REORG_BUFFER = 512;
const SEGMENT_BLOCKS = 250_000;
const PAGE_LIMIT = 20_000;
const EXPECTED_RUST_COMMIT = "357104d3be2e06d91f532563f09c5a9804be088e";

type Kind = "commitments" | "nullifiers" | "operations";
type RecordRow = { id: string; blockNumber: string } & Record<string, unknown>;
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

const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function graphql(query: string, variables: Record<string, unknown>): Promise<Record<string, unknown>> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 4; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120_000);
    try {
      const response = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query, variables }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json() as { data?: Record<string, unknown>; errors?: { message?: string }[] };
      if (body.errors?.length) throw new Error(body.errors.map((e) => e.message).join("; "));
      if (!body.data) throw new Error("Subsquid returned no data");
      return body.data;
    } catch (error) {
      lastError = error;
      if (attempt < 4) await delay(attempt * 1000);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`Subsquid failed: ${String(lastError)}`);
}

function validateRows(rows: RecordRow[], from: number, to: number): void {
  let previous = "";
  for (const row of rows) {
    const block = Number(row.blockNumber);
    if (!row.id || row.id <= previous || !Number.isSafeInteger(block) || block < from || block > to) {
      throw new Error(`Invalid Subsquid row in ${from}..${to}: ${JSON.stringify(row).slice(0, 300)}`);
    }
    previous = row.id;
  }
}

async function queryRows(kind: Kind, query: string, from: number, to: number): Promise<RecordRow[]> {
  const field = kind === "operations" ? "transactions" : kind;
  const rows: RecordRow[] = [];
  let idGt = "";
  while (true) {
    const data = await graphql(query, {
      id_gt: idGt,
      blockNumber_gte: from,
      blockNumber_lte: to,
      limit: PAGE_LIMIT,
    });
    const page = data[field] as RecordRow[] | undefined;
    if (!Array.isArray(page)) throw new Error(`Subsquid response has no ${field} array`);
    if (page.length === 0) break;
    validateRows(page, from, to);
    if (page[0]!.id <= idGt) throw new Error(`Subsquid pagination did not advance for ${kind}`);
    rows.push(...page);
    idGt = page[page.length - 1]!.id;
    if (page.length < PAGE_LIMIT) break;
  }
  validateRows(rows, from, to);
  return rows;
}

async function main(): Promise<void> {
  const [outputArg, release, rustArg] = process.argv.slice(2);
  if (!outputArg || !release || !/^[a-zA-Z0-9._-]+$/.test(release)) {
    throw new Error("Usage: npx tsx scripts/build-sync-cache-v2-railgun.ts <output-dir> <release-id> [kohaku-rs-dir]");
  }
  const root = resolve(outputArg);
  const rust = resolve(rustArg ?? "../kohaku-rs");
  const queryDir = join(rust, "crates/railgun-sync/src/subsquid_graphql");
  const commit = execFileSync("git", ["-C", rust, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const queryChanges = execFileSync("git", ["-C", rust, "status", "--porcelain", "--", "crates/railgun-sync/src/subsquid_graphql"], { encoding: "utf8" }).trim();
  if (commit !== EXPECTED_RUST_COMMIT || queryChanges) {
    throw new Error(`Publisher requires clean kohaku-rs ${EXPECTED_RUST_COMMIT}; found ${commit}${queryChanges ? " with modified GraphQL queries" : ""}`);
  }
  const queries = {
    commitments: readFileSync(join(queryDir, "commitments.graphql"), "utf8"),
    nullifiers: readFileSync(join(queryDir, "nullifiers.graphql"), "utf8"),
    operations: readFileSync(join(queryDir, "operations.graphql"), "utf8"),
    blockNumber: readFileSync(join(queryDir, "block_number.graphql"), "utf8"),
  };
  const manifestPath = join(root, "manifest.json");
  const manifest = parseSyncCacheV2Manifest(readFileSync(manifestPath, "utf8"));
  if (manifest.release !== release || !manifest.sources.sagaMainnet) {
    throw new Error("Build the mainnet Saga snapshot first with the same release ID");
  }
  const tipData = await graphql(queries.blockNumber, {});
  const tip = Number((tipData.transactions as RecordRow[] | undefined)?.[0]?.blockNumber);
  if (!Number.isSafeInteger(tip) || tip <= DEPLOYMENT_BLOCK + REORG_BUFFER) {
    throw new Error(`Invalid Railgun Subsquid tip: ${tip}`);
  }
  const throughBlock = tip - REORG_BUFFER;
  const prefix = "railgun";
  const files = new Map<string, SyncCacheV2File>(manifest.files.map((file) => [file.path, file]));
  const kinds: Kind[] = ["commitments", "nullifiers", "operations"];
  const index: Index = {
    schema: "kohaku-railgun-subsquid-v1",
    chainId: 1,
    endpoint: ENDPOINT,
    fromBlock: DEPLOYMENT_BLOCK,
    throughBlock,
    querySha256: {
      commitments: sha256(queries.commitments),
      nullifiers: sha256(queries.nullifiers),
      operations: sha256(queries.operations),
    },
    segments: { commitments: [], nullifiers: [], operations: [] },
  };
  console.error(`Railgun snapshot ${DEPLOYMENT_BLOCK}..${throughBlock} (Subsquid tip ${tip}, ${REORG_BUFFER}-block buffer)`);
  console.error(`Read pinned query definitions from ${queryDir}`);

  for (let from = DEPLOYMENT_BLOCK; from <= throughBlock; from += SEGMENT_BLOCKS) {
    const to = Math.min(throughBlock, from + SEGMENT_BLOCKS - 1);
    for (const kind of kinds) {
      const name = `${kind}-${from}-${to}.json.gz`;
      const relative = `${prefix}/${name}`;
      const path = join(root, relative);
      mkdirSync(dirname(path), { recursive: true });
      let rows: RecordRow[];
      let compressed: Buffer;
      if (existsSync(path)) {
        compressed = readFileSync(path);
        rows = JSON.parse(gunzipSync(compressed).toString("utf8")) as RecordRow[];
        validateRows(rows, from, to);
      } else {
        rows = await queryRows(kind, queries[kind], from, to);
        compressed = gzipSync(Buffer.from(JSON.stringify(rows)), { level: 6 });
        if (compressed.length > 256 * 1024 * 1024) throw new Error(`Railgun segment too large: ${relative}`);
        writeFileSync(path, compressed);
      }
      index.segments[kind].push({ fromBlock: from, toBlock: to, file: name, count: rows.length });
      files.set(relative, { path: relative, bytes: compressed.length, sha256: sha256(compressed) });
      console.error(`  ${kind} ${from}..${to}: ${rows.length} rows, ${(compressed.length / 1024 / 1024).toFixed(1)} MiB`);
    }
  }
  const indexBytes = Buffer.from(JSON.stringify(index, null, 2) + "\n");
  const indexRelative = `${prefix}/index.json`;
  writeFileSync(join(root, indexRelative), indexBytes);
  files.set(indexRelative, { path: indexRelative, bytes: indexBytes.length, sha256: sha256(indexBytes) });
  const finalManifest: SyncCacheV2Manifest = {
    version: 2,
    createdAt: new Date().toISOString(),
    release,
    files: [...files.values()].sort((a, b) => a.path.localeCompare(b.path)),
    sources: { ...manifest.sources, railgunMainnet: prefix },
  };
  const manifestBytes = JSON.stringify(finalManifest, null, 2) + "\n";
  parseSyncCacheV2Manifest(manifestBytes);
  writeFileSync(manifestPath, manifestBytes);
  console.error(`Complete snapshot: ${finalManifest.files.length} files. Upload saga/ and railgun/ first, then manifest.json last.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
