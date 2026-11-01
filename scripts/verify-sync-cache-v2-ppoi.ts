/** Verify a PPOI extension without needing the already-published Saga/Railgun files locally. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { ppoiSyncSnapshotResponse, PPOI_LEAF_PAGE, PPOI_MAINNET_ENDPOINT } from "../src/utils/ppoi-sync-snapshot.js";
import { getPublicSyncCacheDataDir, setPublicSyncCacheDataDir } from "../src/utils/public-sync-cache.js";
import { parseSyncCacheV2Manifest } from "../src/utils/sync-cache-v2.js";

async function main(): Promise<void> {
  const [outputArg] = process.argv.slice(2);
  if (!outputArg) throw new Error("Usage: npx tsx scripts/verify-sync-cache-v2-ppoi.ts <output-dir>");
  const root = resolve(outputArg);
  const raw = readFileSync(join(root, "manifest.json"), "utf8");
  const manifest = parseSyncCacheV2Manifest(raw);
  assert.equal(manifest.sources.ppoiMainnet, "ppoi", "mainnet PPOI source missing");
  assert.ok(manifest.sources.sagaMainnet && manifest.sources.railgunMainnet, "existing sources missing");
  const index = JSON.parse(readFileSync(join(root, "ppoi/index.json"), "utf8")) as {
    listKey: string; throughLeafExclusive: number;
  };
  const temp = mkdtempSync(join(tmpdir(), "kohaku-v2-ppoi-verify-"));
  const previousDir = getPublicSyncCacheDataDir();
  try {
    const cacheDir = join(temp, "sync-cache-v2");
    for (const file of manifest.files.filter((entry) => entry.path.startsWith("ppoi/"))) {
      const path = join(root, file.path);
      assert.ok(existsSync(path), `missing ${file.path}`);
      const bytes = readFileSync(path);
      assert.equal(bytes.length, file.bytes, `size mismatch ${file.path}`);
      assert.equal(createHash("sha256").update(bytes).digest("hex"), file.sha256, `hash mismatch ${file.path}`);
      const object = join(cacheDir, "objects", file.sha256);
      mkdirSync(dirname(object), { recursive: true });
      if (!existsSync(object)) symlinkSync(path, object);
    }
    writeFileSync(join(cacheDir, "manifest.json"), raw);
    setPublicSyncCacheDataDir(temp);
    const last = index.throughLeafExclusive - PPOI_LEAF_PAGE;
    assert.ok(last >= 0 && last % PPOI_LEAF_PAGE === 0, "invalid PPOI cutoff");
    const middle = Math.floor(last / (2 * PPOI_LEAF_PAGE)) * PPOI_LEAF_PAGE;
    for (const startIndex of [...new Set([0, middle, last])]) {
      const request = JSON.stringify({
        jsonrpc: "2.0", id: startIndex + 1,
        method: "ppoi_poi_merkletree_leaves",
        params: { chainType: "0", chainID: "1", txidVersion: "V2_PoseidonMerkle",
          listKey: index.listKey, startIndex, endIndex: startIndex + PPOI_LEAF_PAGE },
      });
      const local = ppoiSyncSnapshotResponse(PPOI_MAINNET_ENDPOINT, "POST", Buffer.from(request));
      assert.ok(local, `cache miss at leaf ${startIndex}`);
      const remote = await fetch(PPOI_MAINNET_ENDPOINT, {
        method: "POST", headers: { "content-type": "application/json" }, body: request,
      });
      assert.ok(remote.ok, `live PPOI HTTP ${remote.status}`);
      const localBody = await local.json() as { result: string[] };
      const remoteBody = await remote.json() as { result?: string[]; error?: unknown };
      assert.equal(remoteBody.error, undefined, `live PPOI error at ${startIndex}`);
      assert.deepEqual(localBody.result, remoteBody.result, `PPOI page mismatch at ${startIndex}`);
      console.error(`Matched live PPOI leaf page ${startIndex}..${startIndex + PPOI_LEAF_PAGE}`);
    }
    const tipRequest = Buffer.from(JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "ppoi_poi_merkletree_leaves",
      params: { chainType: "0", chainID: "1", txidVersion: "V2_PoseidonMerkle",
        listKey: index.listKey, startIndex: index.throughLeafExclusive,
        endIndex: index.throughLeafExclusive + PPOI_LEAF_PAGE },
    }));
    assert.equal(ppoiSyncSnapshotResponse(PPOI_MAINNET_ENDPOINT, "POST", tipRequest), null, "tip must remain live");
    console.error(`Verified ${manifest.files.filter((entry) => entry.path.startsWith("ppoi/")).length} PPOI files through leaf ${index.throughLeafExclusive}`);
  } finally {
    setPublicSyncCacheDataDir(previousDir);
    rmSync(temp, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
