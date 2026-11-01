/** Verify a built snapshot locally and compare sampled Railgun pages to live Subsquid. */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { decodeAndVerify } from "@saga-sync/client";

import { getPublicSyncCacheDataDir, setPublicSyncCacheDataDir } from "../src/utils/public-sync-cache.js";
import { railgunSyncSnapshotResponse } from "../src/utils/railgun-sync-snapshot.js";
import { hasLocalSyncCacheV2File, parseSyncCacheV2Manifest } from "../src/utils/sync-cache-v2.js";

async function main(): Promise<void> {
  const [outputArg, rustArg] = process.argv.slice(2);
  if (!outputArg) throw new Error("Usage: npx tsx scripts/verify-sync-cache-v2.ts <output-dir> [kohaku-rs-dir]");
  const output = resolve(outputArg);
  const rust = resolve(rustArg ?? "../kohaku-rs");
  const temp = mkdtempSync(join(tmpdir(), "kohaku-verify-v2-"));
  const oldDataDir = getPublicSyncCacheDataDir();
  try {
    const rawManifest = readFileSync(join(output, "manifest.json"), "utf8");
    const manifest = parseSyncCacheV2Manifest(rawManifest);
    assert.ok(manifest.sources.sagaMainnet && manifest.sources.railgunMainnet, "both sources must be present");
    const cacheDir = join(temp, "sync-cache-v2");
    const objectsDir = join(cacheDir, "objects");
    mkdirSync(objectsDir, { recursive: true });
    for (const file of manifest.files) {
      const object = join(objectsDir, file.sha256);
      if (!existsSync(object)) symlinkSync(join(output, file.path), object);
    }
    writeFileSync(join(cacheDir, "manifest.json"), rawManifest);
    setPublicSyncCacheDataDir(temp);
    for (const file of manifest.files) {
      assert.ok(hasLocalSyncCacheV2File(file, temp), `invalid file ${file.path}`);
    }
    console.error(`Verified ${manifest.files.length} SHA-256 hashes`);

    const sagaPrefix = manifest.sources.sagaMainnet;
    const saga = JSON.parse(readFileSync(join(output, sagaPrefix, "index.json"), "utf8")) as {
      availableProtocols: Record<string, { protocol: string; chunks: Parameters<typeof decodeAndVerify>[1][]; extraLogFields?: "transactionHash"[] }>;
    };
    for (const family of ["tornado-cash", "privacy-pools"]) {
      const entries = Object.entries(saga.availableProtocols).filter(([, entry]) => entry.protocol === family);
      assert.ok(entries.length > 0, `${family} streams missing`);
      for (const [id, entry] of entries.slice(0, 2)) {
        const chunk = entry.chunks[0];
        assert.ok(chunk, `${id} has no frozen chunk`);
        await decodeAndVerify(readFileSync(join(output, sagaPrefix, chunk.file)), chunk, { extraLogFields: entry.extraLogFields ?? [] });
      }
      console.error(`Verified Saga decoding for ${family} (${entries.length} streams)`);
    }

    const railgun = JSON.parse(readFileSync(join(output, manifest.sources.railgunMainnet, "index.json"), "utf8")) as {
      endpoint: string; fromBlock: number; throughBlock: number;
    };
    const queryDir = join(rust, "crates/railgun-sync/src/subsquid_graphql");
    const boundary = railgun.fromBlock + 250_000;
    const cases = [
      { from: railgun.fromBlock, to: railgun.fromBlock + 2_000 },
      { from: boundary - 1_000, to: boundary + 1_000 },
      { from: railgun.throughBlock - 5_000, to: railgun.throughBlock },
    ];
    for (const kind of ["commitments", "nullifiers", "operations"] as const) {
      const query = readFileSync(join(queryDir, `${kind}.graphql`), "utf8");
      const field = kind === "operations" ? "transactions" : kind;
      for (const { from, to } of cases) {
        if (from > to || from < railgun.fromBlock) continue;
        let idGt = "";
        for (let page = 0; page < 2; page++) {
          const body = JSON.stringify({ query, variables: { id_gt: idGt, blockNumber_gte: from, blockNumber_lte: to, limit: 3 } });
          const local = railgunSyncSnapshotResponse(railgun.endpoint, "POST", Buffer.from(body));
          assert.ok(local, `snapshot miss for ${kind} ${from}..${to}`);
          const remote = await fetch(railgun.endpoint, { method: "POST", headers: { "content-type": "application/json" }, body });
          assert.ok(remote.ok, `live Subsquid HTTP ${remote.status}`);
          const localRows = ((await local.json()) as { data: Record<string, { id: string }[]> }).data[field];
          const remoteRows = ((await remote.json()) as { data: Record<string, { id: string }[]> }).data[field];
          assert.deepEqual(localRows, remoteRows, `${kind} ${from}..${to} page ${page + 1}`);
          if (!localRows?.length) break;
          idGt = localRows[localRows.length - 1]!.id;
        }
        console.error(`Matched live Subsquid: ${kind} ${from}..${to}`);
      }
    }
    console.error(`Verified release ${manifest.release}`);
  } finally {
    setPublicSyncCacheDataDir(oldDataDir);
    rmSync(temp, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
