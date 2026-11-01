/**
 * Append complete historical mainnet PPOI leaf pages to an existing v2 release.
 * The Saga and Railgun files may already be published; only their manifest
 * entries are needed locally. The growing leaf page and all validation RPCs
 * remain live.
 *
 * npx tsx scripts/build-sync-cache-v2-ppoi.ts <output-dir> <release-id> [kohaku-rs-dir]
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";

import {
  PPOI_LEAF_PAGE,
  PPOI_MAINNET_ENDPOINT,
  PPOI_SEGMENT_LEAVES,
  PPOI_ZERO_LEAF,
} from "../src/utils/ppoi-sync-snapshot.js";
import { parseSyncCacheV2Manifest, type SyncCacheV2File, type SyncCacheV2Manifest } from "../src/utils/sync-cache-v2.js";

const EXPECTED_RUST_COMMIT = "357104d3be2e06d91f532563f09c5a9804be088e";
const MAINNET_LIST_KEY = "efc6ddb59c098a13fb2b618fdae94c1c3a807abc8fb1837c93620c9143ee9e88";
const MAX_PAGES = 100_000;
const MAX_PARALLEL = 4;
const FETCH_BATCH_LEAVES = 2_000;
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const delay = (ms: number) => new Promise((done) => setTimeout(done, ms));

type Segment = { fromIndex: number; toIndexExclusive: number; file: string };
const leafHex = /^(?:0x)?[0-9a-fA-F]{1,64}$/;

function isZero(leaf: string): boolean {
  return leaf.replace(/^0x/, "").padStart(64, "0").toLowerCase() === PPOI_ZERO_LEAF;
}

function validateLeaves(leaves: unknown, expected: number): string[] {
  if (!Array.isArray(leaves) || leaves.length !== expected ||
      !leaves.every((leaf) => typeof leaf === "string" && leafHex.test(leaf) && !isZero(leaf))) {
    throw new Error(`Invalid or incomplete historical PPOI segment (expected ${expected} leaves)`);
  }
  return leaves as string[];
}

async function fetchPage(startIndex: number): Promise<string[]> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 4; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 45_000);
    try {
      const response = await fetch(PPOI_MAINNET_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0", id: startIndex + 1,
          method: "ppoi_poi_merkletree_leaves",
          params: {
            chainType: "0", chainID: "1", txidVersion: "V2_PoseidonMerkle",
            listKey: MAINNET_LIST_KEY,
            startIndex, endIndex: startIndex + PPOI_LEAF_PAGE,
          },
        }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json() as { jsonrpc?: string; id?: number; result?: unknown; error?: { message?: string } };
      if (body.jsonrpc !== "2.0" || body.id !== startIndex + 1 || body.error || !Array.isArray(body.result)) {
        throw new Error(`Invalid PPOI response at ${startIndex}: ${body.error?.message ?? "bad JSON-RPC envelope"}`);
      }
      const leaves = body.result as unknown[];
      if (leaves.length > PPOI_LEAF_PAGE || !leaves.every((leaf) => typeof leaf === "string" && leafHex.test(leaf))) {
        throw new Error(`Invalid PPOI leaves at ${startIndex}`);
      }
      if (leaves.length < PPOI_LEAF_PAGE && !leaves.some((leaf) => isZero(leaf as string))) {
        throw new Error(`Short PPOI page without zero leaf at ${startIndex}`);
      }
      return leaves as string[];
    } catch (error) {
      lastError = error;
      if (attempt < 4) await delay(attempt * 1_000);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`PPOI page ${startIndex} failed: ${String(lastError)}`);
}

async function fetchBatch(start: number): Promise<string[][]> {
  const pages: string[][] = new Array(FETCH_BATCH_LEAVES / PPOI_LEAF_PAGE);
  let next = 0;
  const worker = async () => {
    while (next < pages.length) {
      const slot = next++;
      pages[slot] = await fetchPage(start + slot * PPOI_LEAF_PAGE);
    }
  };
  await Promise.all(Array.from({ length: MAX_PARALLEL }, () => worker()));
  return pages;
}

async function main(): Promise<void> {
  const [outputArg, release, rustArg] = process.argv.slice(2);
  if (!outputArg || !release || !/^[a-zA-Z0-9._-]+$/.test(release)) {
    throw new Error("Usage: npx tsx scripts/build-sync-cache-v2-ppoi.ts <output-dir> <release-id> [kohaku-rs-dir]");
  }
  const root = resolve(outputArg);
  const rust = resolve(rustArg ?? "../kohaku-rs");
  const commit = execFileSync("git", ["-C", rust, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const chainConfig = readFileSync(join(rust, "crates/railgun/src/chain_config.rs"), "utf8");
  if (commit !== EXPECTED_RUST_COMMIT || !chainConfig.includes(PPOI_MAINNET_ENDPOINT) ||
      !chainConfig.includes(MAINNET_LIST_KEY)) {
    throw new Error(`PPOI publisher requires pinned kohaku-rs ${EXPECTED_RUST_COMMIT} with matching mainnet configuration`);
  }
  const manifestPath = join(root, "manifest.json");
  const manifest = parseSyncCacheV2Manifest(readFileSync(manifestPath, "utf8"));
  if (!manifest.sources.sagaMainnet || !manifest.sources.railgunMainnet) {
    throw new Error("Existing v2 manifest must include Saga and Railgun mainnet sources");
  }
  const directory = join(root, "ppoi");
  mkdirSync(directory, { recursive: true });
  const files = new Map<string, SyncCacheV2File>(manifest.files.filter((file) => !file.path.startsWith("ppoi/")).map((file) => [file.path, file]));
  const segments: Segment[] = [];
  let pending: string[] = [];
  let cursor = 0;
  while (cursor / PPOI_LEAF_PAGE < MAX_PAGES) {
    if (pending.length === 0) {
      const fullEnd = cursor + PPOI_SEGMENT_LEAVES;
      const fullFile = `leaves-${cursor}-${fullEnd}.json.gz`;
      if (existsSync(join(directory, fullFile))) {
        const raw = gunzipSync(readFileSync(join(directory, fullFile)), { maxOutputLength: 4 * 1024 * 1024 });
        validateLeaves(JSON.parse(raw.toString("utf8")), PPOI_SEGMENT_LEAVES);
        const compressed = readFileSync(join(directory, fullFile));
        files.set(`ppoi/${fullFile}`, { path: `ppoi/${fullFile}`, bytes: compressed.length, sha256: sha256(compressed) });
        segments.push({ fromIndex: cursor, toIndexExclusive: fullEnd, file: fullFile });
        cursor = fullEnd;
        console.error(`Reused PPOI historical leaves through ${cursor.toLocaleString("en-US")}`);
        continue;
      }
    }
    const expectedEnd = cursor + FETCH_BATCH_LEAVES;
    const reusable = `leaves-${cursor}-${expectedEnd}.json.gz`;
    let leaves: string[];
    if (existsSync(join(directory, reusable))) {
      const raw = gunzipSync(readFileSync(join(directory, reusable)), { maxOutputLength: 4 * 1024 * 1024 });
      leaves = validateLeaves(JSON.parse(raw.toString("utf8")), FETCH_BATCH_LEAVES);
    } else {
      const pages = await fetchBatch(cursor);
      leaves = [];
      for (const page of pages) {
        if (page.length !== PPOI_LEAF_PAGE || page.some(isZero)) break;
        leaves.push(...page);
      }
    }
    if (leaves.length > 0) {
      // Keep small completed batches as restart checkpoints until the final segment is written.
      if (leaves.length === FETCH_BATCH_LEAVES && !existsSync(join(directory, reusable))) {
        writeFileSync(join(directory, reusable), gzipSync(Buffer.from(JSON.stringify(leaves)), { level: 6 }));
      }
      pending.push(...leaves);
      cursor += leaves.length;
    }
    if (pending.length === PPOI_SEGMENT_LEAVES || leaves.length < FETCH_BATCH_LEAVES) {
      if (pending.length > 0) {
        const start = cursor - pending.length;
        const file = `leaves-${start}-${cursor}.json.gz`;
        const compressed = gzipSync(Buffer.from(JSON.stringify(pending)), { level: 6 });
        writeFileSync(join(directory, file), compressed);
        const relative = `ppoi/${file}`;
        files.set(relative, { path: relative, bytes: compressed.length, sha256: sha256(compressed) });
        segments.push({ fromIndex: start, toIndexExclusive: cursor, file });
        console.error(`PPOI historical leaves through ${cursor.toLocaleString("en-US")} (${(compressed.length / 1024).toFixed(0)} KiB)`);
        pending = [];
      }
    }
    if (leaves.length < FETCH_BATCH_LEAVES) break;
  }
  if (cursor === 0 || cursor / PPOI_LEAF_PAGE >= MAX_PAGES) {
    throw new Error("PPOI publisher found no complete pages or reached the safety page cap");
  }
  const index = {
    schema: "kohaku-railgun-ppoi-v1", chainId: 1,
    endpoint: PPOI_MAINNET_ENDPOINT, listKey: MAINNET_LIST_KEY,
    txidVersion: "V2_PoseidonMerkle", pageSize: PPOI_LEAF_PAGE,
    throughLeafExclusive: cursor, segments,
  };
  const indexBytes = Buffer.from(JSON.stringify(index, null, 2) + "\n");
  writeFileSync(join(directory, "index.json"), indexBytes);
  files.set("ppoi/index.json", { path: "ppoi/index.json", bytes: indexBytes.length, sha256: sha256(indexBytes) });
  const updated: SyncCacheV2Manifest = {
    version: 2, createdAt: new Date().toISOString(), release,
    files: [...files.values()].sort((a, b) => a.path.localeCompare(b.path)),
    sources: { ...manifest.sources, ppoiMainnet: "ppoi" },
  };
  const rawManifest = JSON.stringify(updated, null, 2) + "\n";
  parseSyncCacheV2Manifest(rawManifest);
  writeFileSync(manifestPath, rawManifest);
  const published = new Set(files.keys());
  for (const file of readdirSync(directory)) {
    if (/^leaves-\d+-\d+\.json\.gz$/.test(file) && !published.has(`ppoi/${file}`)) {
      unlinkSync(join(directory, file));
    }
  }
  console.error(`PPOI snapshot complete: ${cursor.toLocaleString("en-US")} leaves, ${segments.length} segments. Upload ppoi/ first, manifest.json last.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
