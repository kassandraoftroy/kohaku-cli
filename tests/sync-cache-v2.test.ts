import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";

import { getPublicSyncCacheDataDir, setPublicSyncCacheDataDir } from "../src/utils/public-sync-cache.js";
import { kohakuFetch } from "../src/utils/tor.js";
import { railgunSyncSnapshotResponse } from "../src/utils/railgun-sync-snapshot.js";
import {
  ppoiSyncSnapshotResponse,
  PPOI_MAINNET_ENDPOINT,
  PPOI_ZERO_LEAF,
} from "../src/utils/ppoi-sync-snapshot.js";
import {
  installSyncCacheV2Manifest,
  localSyncCacheV2Source,
  localSyncCacheV2Response,
  parseSyncCacheV2Manifest,
  syncCacheV2ObjectPath,
  type SyncCacheV2File,
} from "../src/utils/sync-cache-v2.js";

const hash = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");

test("v2 rejects unsafe and incomplete releases", () => {
  const base = {
    version: 2,
    createdAt: "2026-10-31T00:00:00.000Z",
    release: "test",
    sources: { sagaMainnet: "saga" },
  };
  assert.throws(() => parseSyncCacheV2Manifest(JSON.stringify({
    ...base,
    files: [{ path: "saga/../secret", bytes: 1, sha256: hash("x") }],
  })), /Unsafe/);
  assert.throws(() => parseSyncCacheV2Manifest(JSON.stringify({
    ...base,
    files: [{ path: "saga/file", bytes: 1, sha256: hash("x") }],
  })), /no index.json/);
  assert.throws(() => parseSyncCacheV2Manifest(JSON.stringify({
    ...base,
    files: [{ path: "releases/test/saga/index.json", bytes: 1, sha256: hash("x") }],
  })), /outside the protocol directories/);
  const dir = mkdtempSync(join(tmpdir(), "kohaku-v2-test-"));
  try {
    assert.throws(() => installSyncCacheV2Manifest(JSON.stringify({
      ...base,
      files: [{ path: "saga/index.json", bytes: 1, sha256: hash("x") }],
    }), dir), /incomplete/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("v2 Railgun cache serves bounded pages independent of requested windows", async () => {
  const previousDir = getPublicSyncCacheDataDir();
  const dataDir = mkdtempSync(join(tmpdir(), "kohaku-v2-test-"));
  setPublicSyncCacheDataDir(dataDir);
  try {
    const prefix = "railgun";
    const sagaPrefix = "saga";
    const endpoint = "https://rail-squid.squids.live/squid-railgun-ethereum-v2/v/v1/graphql";
    const queries = { commitments: "query CommitmentsQuery { commitments { id } }", nullifiers: "query NullifiersQuery { nullifiers { id } }", operations: "query OperationsQuery { transactions { id } }" };
    const fileMap = new Map<string, SyncCacheV2File>();
    const put = (relative: string, bytes: Buffer) => {
      const file = { path: relative, bytes: bytes.length, sha256: hash(bytes) };
      const path = syncCacheV2ObjectPath(file, dataDir);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, bytes);
      fileMap.set(relative, file);
    };
    put(`${sagaPrefix}/index.json`, Buffer.from("{}"));
    const records = {
      commitments: [{ id: "a", blockNumber: "11" }, { id: "c", blockNumber: "13" }, { id: "e", blockNumber: "18" }],
      nullifiers: [{ id: "b", blockNumber: "12" }],
      operations: [{ id: "d", blockNumber: "17", hasUnshield: true }],
    };
    const segments: Record<string, { fromBlock: number; toBlock: number; file: string; count: number }[]> = {};
    for (const kind of Object.keys(records) as (keyof typeof records)[]) {
      segments[kind] = [];
      for (const [from, to] of [[10, 14], [15, 19]]) {
        const rows = records[kind].filter((row) => Number(row.blockNumber) >= from && Number(row.blockNumber) <= to);
        const file = `${kind}-${from}-${to}.json.gz`;
        put(`${prefix}/${file}`, gzipSync(Buffer.from(JSON.stringify(rows))));
        segments[kind]!.push({ fromBlock: from, toBlock: to, file, count: rows.length });
      }
    }
    put(`${prefix}/index.json`, Buffer.from(JSON.stringify({
      schema: "kohaku-railgun-subsquid-v1", chainId: 1, endpoint,
      fromBlock: 10, throughBlock: 19,
      querySha256: Object.fromEntries(Object.entries(queries).map(([kind, query]) => [kind, hash(query)])),
      segments,
    })));
    installSyncCacheV2Manifest(JSON.stringify({
      version: 2, createdAt: "2026-10-31T00:00:00.000Z", release: "test",
      sources: { sagaMainnet: sagaPrefix, railgunMainnet: prefix },
      files: [...fileMap.values()],
    }), dataDir);

    const request = (query: string, from: number, to: number, idGt = "", limit = 20) =>
      railgunSyncSnapshotResponse(endpoint, "POST", Buffer.from(JSON.stringify({
        query,
        variables: { blockNumber_gte: from, blockNumber_lte: to, id_gt: idGt, limit },
      })));
    const first = request(queries.commitments, 11, 18, "", 2);
    assert.ok(first);
    assert.deepEqual((await first.json()).data.commitments.map((row: { id: string }) => row.id), ["a", "c"]);
    const next = request(queries.commitments, 11, 18, "c", 2);
    assert.ok(next);
    assert.deepEqual((await next.json()).data.commitments.map((row: { id: string }) => row.id), ["e"]);
    const txids = request(queries.operations, 10, 19);
    assert.ok(txids);
    assert.equal((await txids.json()).data.transactions[0].hasUnshield, true);
    assert.equal(request(queries.commitments, 10, 20), null);
    assert.equal(request("query NewFields { commitments { id newField } }", 10, 19), null);
    assert.equal(railgunSyncSnapshotResponse("https://other.example/graphql", "POST", Buffer.from("{}")), null);
    const local = localSyncCacheV2Response("https://artifacts.0000000000.org/sync-cache/v2/saga/index.json", dataDir);
    assert.ok(local);
    assert.equal(await local.text(), "{}");
    writeFileSync(syncCacheV2ObjectPath(fileMap.get(`${sagaPrefix}/index.json`)!, dataDir), "corrupt");
    assert.equal(localSyncCacheV2Source("sagaMainnet", dataDir), null);
    writeFileSync(syncCacheV2ObjectPath(fileMap.get(`${prefix}/index.json`)!, dataDir), "corrupt");
    assert.equal(request(queries.commitments, 10, 19), null);
  } finally {
    setPublicSyncCacheDataDir(previousDir);
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("v2 PPOI cache serves complete mainnet leaf pages and leaves validation live", async () => {
  const previousDir = getPublicSyncCacheDataDir();
  const dataDir = mkdtempSync(join(tmpdir(), "kohaku-v2-ppoi-test-"));
  setPublicSyncCacheDataDir(dataDir);
  try {
    const listKey = "a".repeat(64);
    const leaves = Array.from({ length: 200 }, (_, i) => `0x${(i + 1).toString(16).padStart(64, "0")}`);
    const segment = gzipSync(Buffer.from(JSON.stringify(leaves)));
    const index = Buffer.from(JSON.stringify({
      schema: "kohaku-railgun-ppoi-v1", chainId: 1, endpoint: PPOI_MAINNET_ENDPOINT,
      listKey, txidVersion: "V2_PoseidonMerkle", pageSize: 100,
      throughLeafExclusive: 200,
      segments: [{ fromIndex: 0, toIndexExclusive: 200, file: "leaves-0-200.json.gz" }],
    }));
    const files = [
      { path: "ppoi/index.json", bytes: index.length, sha256: hash(index) },
      { path: "ppoi/leaves-0-200.json.gz", bytes: segment.length, sha256: hash(segment) },
    ];
    for (const [file, bytes] of [[files[0]!, index], [files[1]!, segment]] as const) {
      const path = syncCacheV2ObjectPath(file, dataDir);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, bytes);
    }
    installSyncCacheV2Manifest(JSON.stringify({
      version: 2, createdAt: "2026-11-01T00:00:00.000Z", release: "ppoi-test",
      sources: { ppoiMainnet: "ppoi" }, files,
    }), dataDir);
    const request = (startIndex: number, overrides: Record<string, unknown> = {}) => Buffer.from(JSON.stringify({
      jsonrpc: "2.0", id: 42, method: "ppoi_poi_merkletree_leaves",
      params: { chainType: "0", chainID: "1", txidVersion: "V2_PoseidonMerkle",
        listKey, startIndex, endIndex: startIndex + 100, ...overrides },
    }));
    const first = ppoiSyncSnapshotResponse(PPOI_MAINNET_ENDPOINT, "POST", request(0));
    assert.ok(first);
    assert.equal(first.url, PPOI_MAINNET_ENDPOINT);
    assert.deepEqual(await first.json(), { jsonrpc: "2.0", id: 42, result: leaves.slice(0, 100) });
    const intercepted = await kohakuFetch(new Request(PPOI_MAINNET_ENDPOINT, {
      method: "POST", headers: { "content-type": "application/json" }, body: request(0),
    }));
    assert.equal(intercepted.headers.get("x-kohaku-public-cache"), "v2-ppoi-hit");
    assert.deepEqual((await intercepted.json()).result, leaves.slice(0, 100));
    assert.deepEqual((await ppoiSyncSnapshotResponse(PPOI_MAINNET_ENDPOINT, "POST", request(100))?.json())?.result, leaves.slice(100));
    assert.equal(ppoiSyncSnapshotResponse(PPOI_MAINNET_ENDPOINT, "POST", request(200)), null);
    assert.equal(ppoiSyncSnapshotResponse(PPOI_MAINNET_ENDPOINT, "POST", request(0, { listKey: "b".repeat(64) })), null);
    assert.equal(ppoiSyncSnapshotResponse(PPOI_MAINNET_ENDPOINT, "POST", request(0, { chainID: "11155111" })), null);
    assert.equal(ppoiSyncSnapshotResponse(PPOI_MAINNET_ENDPOINT, "POST", Buffer.from(JSON.stringify({
      jsonrpc: "2.0", id: 42, method: "ppoi_validate_poi_merkleroots", params: {},
    }))), null);
    const bad = gzipSync(Buffer.from(JSON.stringify([PPOI_ZERO_LEAF, ...leaves.slice(1)])));
    writeFileSync(syncCacheV2ObjectPath(files[1]!, dataDir), bad);
    assert.equal(ppoiSyncSnapshotResponse(PPOI_MAINNET_ENDPOINT, "POST", request(0)), null);
  } finally {
    setPublicSyncCacheDataDir(previousDir);
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("v2 keeps the active snapshot usable while updated root paths download", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "kohaku-v2-update-test-"));
  try {
    const first = Buffer.from("first index");
    const second = Buffer.from("second index");
    const manifest = (bytes: Buffer, release: string) => JSON.stringify({
      version: 2,
      createdAt: "2026-10-31T00:00:00.000Z",
      release,
      sources: { sagaMainnet: "saga" },
      files: [{ path: "saga/index.json", bytes: bytes.length, sha256: hash(bytes) }],
    });
    const oldFile = { path: "saga/index.json", bytes: first.length, sha256: hash(first) };
    const newFile = { path: "saga/index.json", bytes: second.length, sha256: hash(second) };
    mkdirSync(dirname(syncCacheV2ObjectPath(oldFile, dataDir)), { recursive: true });
    writeFileSync(syncCacheV2ObjectPath(oldFile, dataDir), first);
    installSyncCacheV2Manifest(manifest(first, "old"), dataDir);
    const url = "https://artifacts.0000000000.org/sync-cache/v2/saga/index.json";
    assert.equal(await localSyncCacheV2Response(url, dataDir)?.text(), "first index");
    assert.throws(() => installSyncCacheV2Manifest(manifest(second, "new"), dataDir), /incomplete/);
    assert.equal(await localSyncCacheV2Response(url, dataDir)?.text(), "first index");
    writeFileSync(syncCacheV2ObjectPath(newFile, dataDir), second);
    installSyncCacheV2Manifest(manifest(second, "new"), dataDir);
    assert.equal(await localSyncCacheV2Response(url, dataDir)?.text(), "second index");
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
