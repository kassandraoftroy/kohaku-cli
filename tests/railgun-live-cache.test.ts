import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { cacheRailgunLiveResponse, railgunLiveCacheResponse } from "../src/utils/railgun-live-cache.js";
import { getPublicSyncCacheDataDir, setPublicSyncCacheDataDir } from "../src/utils/public-sync-cache.js";
import { PPOI_MAINNET_ENDPOINT, PPOI_ZERO_LEAF } from "../src/utils/ppoi-sync-snapshot.js";
import { syncCacheV2Dir } from "../src/utils/sync-cache-v2.js";

const encode = (value: unknown) => Buffer.from(JSON.stringify(value));
const page = (start: number, id = 1) => ({ jsonrpc: "2.0", id, method: "ppoi_poi_merkletree_leaves", params: {
  chainType: "0", chainID: "1", txidVersion: "V2_PoseidonMerkle", listKey: "a".repeat(64),
  startIndex: start, endIndex: start + 100,
} });

test("shared live cache reuses complete PPOI pages with the current request ID, never tip or status answers", async () => {
  const previous = getPublicSyncCacheDataDir();
  const dir = mkdtempSync(join(tmpdir(), "kohaku-live-ppoi-"));
  setPublicSyncCacheDataDir(dir);
  try {
    const leaves = Array.from({ length: 100 }, (_, i) => `0x${(i + 1).toString(16)}`);
    await cacheRailgunLiveResponse(PPOI_MAINNET_ENDPOINT, encode(page(0)), Response.json({ jsonrpc: "2.0", id: 1, result: leaves }));
    const response = await railgunLiveCacheResponse(PPOI_MAINNET_ENDPOINT, encode(page(0, 99)));
    assert.equal(response?.headers.get("x-kohaku-public-cache"), "v2-live-hit");
    assert.deepEqual(await response?.json(), { jsonrpc: "2.0", id: 99, result: leaves });

    for (const result of [leaves.slice(0, 99), [], [...leaves.slice(0, 99), PPOI_ZERO_LEAF]]) {
      await cacheRailgunLiveResponse(PPOI_MAINNET_ENDPOINT, encode(page(100)), Response.json({ jsonrpc: "2.0", id: 1, result }));
      assert.equal(await railgunLiveCacheResponse(PPOI_MAINNET_ENDPOINT, encode(page(100))), null);
    }
    for (const method of ["ppoi_validate_poi_merkleroots", "ppoi_validate_txid_merkleroot", "ppoi_validated_txid", "ppoi_submit_transact_proof", "ppoi_pois_per_list"]) {
      const body = encode({ ...page(0), method });
      await cacheRailgunLiveResponse(PPOI_MAINNET_ENDPOINT, body, Response.json({ jsonrpc: "2.0", id: 1, result: true }));
      assert.equal(await railgunLiveCacheResponse(PPOI_MAINNET_ENDPOINT, body), null);
    }
    const liveDir = join(syncCacheV2Dir(), "live");
    const [file] = readdirSync(liveDir);
    assert.equal(readdirSync(liveDir).length, 1);
    writeFileSync(join(liveDir, file!), "corrupt gzip");
    assert.equal(await railgunLiveCacheResponse(PPOI_MAINNET_ENDPOINT, encode(page(0))), null);
    const consumed = Response.json({ jsonrpc: "2.0", id: 1, result: leaves });
    await consumed.text();
    await assert.doesNotReject(cacheRailgunLiveResponse(PPOI_MAINNET_ENDPOINT, encode(page(200)), consumed));
  } finally { setPublicSyncCacheDataDir(previous); rmSync(dir, { recursive: true, force: true }); }
});

test("indexer caching requires a live head and keeps a confirmation buffer; head and unknown queries stay live", async () => {
  const previous = getPublicSyncCacheDataDir();
  const dir = mkdtempSync(join(tmpdir(), "kohaku-live-indexer-"));
  setPublicSyncCacheDataDir(dir);
  const endpoint = "https://rail-squid.squids.live/squid-railgun-ethereum-v2/v/v1/graphql";
  const query = readFileSync(new URL("./fixtures/railgun-commitments.graphql", import.meta.url), "utf8");
  const body = (from: number, to: number) => encode({ query, variables: {
    blockNumber_gte: from, blockNumber_lte: to, id_gt: "", limit: 20000,
  } });
  const data = { commitments: [{ id: "a", blockNumber: "11", hash: "public fixture" }] };
  try {
    await cacheRailgunLiveResponse(endpoint, body(10, 20), Response.json({ data }));
    assert.equal(await railgunLiveCacheResponse(endpoint, body(10, 20)), null);
    const head = encode({ query: "query BlockNumberQuery {\n  transactions(orderBy: blockNumber_DESC, limit: 1) {\n    blockNumber\n  }\n}\n", variables: {} });
    await cacheRailgunLiveResponse(endpoint, head, Response.json({ data: { transactions: [{ blockNumber: "1000" }] } }));
    assert.equal(await railgunLiveCacheResponse(endpoint, head), null);
    await cacheRailgunLiveResponse(endpoint, body(10, 20), Response.json({ data }));
    assert.deepEqual(await (await railgunLiveCacheResponse(endpoint, body(10, 20)))?.json(), { data });
    await cacheRailgunLiveResponse(endpoint, body(990, 1000), Response.json({ data: { commitments: [] } }));
    assert.equal(await railgunLiveCacheResponse(endpoint, body(990, 1000)), null);
    const unknown = encode({ query: query + "# unrecognized schema", variables: { blockNumber_gte: 10, blockNumber_lte: 20, id_gt: "", limit: 20000 } });
    await cacheRailgunLiveResponse(endpoint, unknown, Response.json({ data }));
    assert.equal(await railgunLiveCacheResponse(endpoint, unknown), null);
  } finally { setPublicSyncCacheDataDir(previous); rmSync(dir, { recursive: true, force: true }); }
});
