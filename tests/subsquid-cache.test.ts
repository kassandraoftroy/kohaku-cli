import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";

import { kohakuFetch } from "../src/utils/tor.js";
import { getPublicSyncCacheDataDir, setPublicSyncCacheDataDir, writePublicSyncCache } from "../src/utils/public-sync-cache.js";

it("ignores legacy v1 Subsquid pages after upgrading to v2", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kohaku-live-squid-"));
  const previousDir = getPublicSyncCacheDataDir();
  let requests = 0;
  const server = createServer((_request, response) => {
    requests++;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ data: { transactions: [{ blockNumber: "26253987" }] } }));
  });
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const url = `http://127.0.0.1:${address.port}/subsquid/graphql`;
    const head = JSON.stringify({ query: `query BlockNumberQuery {
      transactions(orderBy: blockNumber_DESC, limit: 1) { blockNumber }
    }` });
    const history = JSON.stringify({ query: `query CommitmentsQuery($blockNumber_lte: BigInt) {
      commitments(where: {blockNumber_lte: $blockNumber_lte}) { blockNumber }
    }`, variables: { blockNumber_lte: "25832229" } });
    setPublicSyncCacheDataDir(dir);
    for (const body of [head, history]) writePublicSyncCache({ dataDir: dir, url, method: "POST", body,
      responseBody: Buffer.from(JSON.stringify({ data: { transactions: [{ blockNumber: "25832229" }] } })),
      contentType: "application/json" });
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await kohakuFetch(url, { method: "POST", body: head });
      assert.equal((await response.json()).data.transactions[0].blockNumber, "26253987");
    }
    assert.equal(requests, 2, "head queries must hit the live indexer every time");
    const response = await kohakuFetch(url, { method: "POST", body: history });
    assert.equal((await response.json()).data.transactions[0].blockNumber, "26253987");
    assert.equal(requests, 3, "legacy v1 history must not be read by the v2 runtime");
  } finally {
    setPublicSyncCacheDataDir(previousDir);
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});
