import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { describe, it } from "node:test";
import { toExternalSyncClient } from "@kohaku-eth/plugins";
import type { ExternalRawEvent, Network } from "@kohaku-eth/plugins";

import { createSagaExternalSyncProvider, sagaBaseUrlForChain } from "../src/utils/saga-external-sync.js";

const registry = "0x58e8dcc13be9780fc42e8723d8ead4cf46943df2" as const;
const pool = "0x12d66f87a04a9e220743712ce6d9bb1b5616b8fc" as const;
const baseUrl = sagaBaseUrlForChain(1n);

function event(address: `0x${string}`, block: number): ExternalRawEvent {
  return { contractAddress: address, blockNumber: `0x${block.toString(16)}`,
    eventTopic: "0x01", topics: ["0x01"], data: "0x", logIndex: "0x0" };
}

function fixture() {
  const requests: string[] = [];
  const manifest = { availableProtocols: {
    // The live mainnet manifest puts this derived, address-less stream before
    // Tornado entries. It must not throw and trigger the SDK's RPC fallback.
    "railgun-1-ops": { chainId: "0x1", chunks: [] },
    "tornado-cash-1-relayer-registry": {
      chainId: "0x1", trackedAddresses: [registry],
      chunks: [{ fromBlock: "0xa", toBlock: "0x14", file: "registry.jsonl.gz" }],
      hotHead: { fromBlock: "0x14", toBlock: "0x1e", file: "registry.hot.jsonl.gz" },
    },
    "tornado-cash-1-eth-0.1": {
      chainId: "0x1", trackedAddresses: [pool], chunks: [],
      hotHead: { fromBlock: "0x0", toBlock: "0x1e", file: "pool.hot.jsonl.gz" },
    },
  } };
  const files: Record<string, ExternalRawEvent[]> = {
    "registry.jsonl.gz": [event(registry, 18), event(registry, 10)],
    "registry.hot.jsonl.gz": [event(registry, 29), event(registry, 20)],
    "pool.hot.jsonl.gz": [event(pool, 12)],
  };
  const network: Network = { fetch: async (input) => {
    const url = String(input);
    requests.push(url);
    if (url === `${baseUrl}/index.json`) return Response.json(manifest);
    const filename = url.slice(baseUrl.length + 1);
    assert.ok(filename in files, `unexpected fetch: ${url}`);
    return new Response(gzipSync(files[filename]!.map((row) => JSON.stringify(row)).join("\n")));
  } };
  return { provider: createSagaExternalSyncProvider({ baseUrl, network }), requests };
}

describe("Tornado Saga manifest lookup", () => {
  it("finds registry coverage past unrelated streams without trackedAddresses", async () => {
    const { provider, requests } = fixture();
    const client = toExternalSyncClient(provider);
    const params = { chainId: "0x1" as const, address: registry };
    assert.equal(await client.firstCoveredBlock(params), "0xa");
    assert.equal(await client.lastCoveredBlock(params), "0x1d");
    assert.deepEqual(requests, [`${baseUrl}/index.json`]);
  });

  it("downloads registry history through the SDK's external-sync adapter", async () => {
    const { provider, requests } = fixture();
    const client = toExternalSyncClient(provider);
    const events = await client.getEvents({ chainId: "0x1", address: registry,
      fromBlock: "0xa", toBlock: "0x1d" });
    assert.deepEqual(events.map((row) => BigInt(row.blockNumber)), [10n, 18n, 20n, 29n]);
    assert.deepEqual(requests, ["index.json", "registry.jsonl.gz", "registry.hot.jsonl.gz"]
      .map((path) => `${baseUrl}/${path}`));
  });

  it("finds pool history too and matches checksummed addresses", async () => {
    const { provider } = fixture();
    const client = toExternalSyncClient(provider);
    assert.equal(await client.lastCoveredBlock({ chainId: "0x1", address: pool }), "0x1d");
    assert.equal(await client.lastCoveredBlock({ chainId: "0x1",
      address: "0x58E8dCC13BE9780fC42E8723D8EaD4CF46943dF2" }), "0x1d");
  });

  it("reports missing coverage normally instead of throwing on another protocol", async () => {
    const { provider } = fixture();
    await assert.rejects(provider.lastCoveredBlock({ chainId: "0x1", address: "0x0000" }),
      /Saga has no protocol data/);
    await assert.rejects(provider.lastCoveredBlock({ chainId: "0xaa36a7", address: registry }),
      /Saga has no protocol data/);
  });
});
