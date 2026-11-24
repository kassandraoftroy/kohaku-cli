import assert from "node:assert/strict";
import { it } from "node:test";
import type { Host } from "@kohaku-eth/plugins";
import { getPPv1ChainStateKey, PrivacyPoolsV1_0xBow } from "@kohaku-eth/privacy-pools";
import { toHex } from "viem";
import { createSchemedPlugins } from "../src/utils/plugins.js";

it("PPv1 ignores old wallet snapshots and shares the rebuilt chain state across note schemes", async () => {
  const chainId = 11155111n;
  const entrypoint = PrivacyPoolsV1_0xBow[11155111].entrypoint;
  const address = BigInt(entrypoint.entrypointAddress);
  const newKey = getPPv1ChainStateKey(chainId, address);
  const oldKey = `privacy-pool-state-${chainId}-${address}`;
  const saved = new Map([[oldKey, "obsolete state"], [`sig:${oldKey}`, "obsolete state"]]);
  const reads: string[] = [];
  const scans: bigint[] = [];
  const head = entrypoint.deploymentBlock + 5n;
  const finalized = head - 2n;
  let finalizedReads = 0;
  const host = {
    storage: { _brand: "Storage", get: async (key: string) => {
      reads.push(key); return saved.get(key) ?? null;
    }, set: async (key: string, value: string) => { saved.set(key, value); } },
    provider: {
      getChainId: async () => chainId, getBlockNumber: async () => head,
      getLogs: async ({ fromBlock }: { fromBlock: bigint }) => { scans.push(fromBlock); return []; },
      request: async ({ method, params }: { method: string; params?: unknown[] }) => {
        if (method === "eth_chainId") return toHex(chainId);
        if (method === "eth_getBlockByNumber") {
          assert.deepEqual(params, ["finalized", false]);
          finalizedReads++;
          return { number: toHex(finalized) };
        }
        throw new Error(`Unexpected RPC request: ${method}`);
      },
    },
    keystore: { deriveAt: async () => `0x${"12".repeat(32)}` },
    network: { fetch: async () => { throw new Error("Unexpected network request"); } },
  } as unknown as Host;
  const plugins = await createSchemedPlugins("privacy-pools", host, chainId);
  await plugins.legacy.sync!();
  await plugins.signature.sync!();
  assert.equal(reads.filter((key) => key === newKey).length, 1, JSON.stringify(reads));
  assert.ok(!reads.includes(oldKey) && !reads.includes(`sig:${oldKey}`));
  assert.ok(saved.has(newKey));
  assert.ok(!saved.has(`sig:${newKey}`));
  assert.equal(saved.get(oldKey), "obsolete state");
  // The second scheme reuses the shared chain state and replays its unfinalized
  // tail, rather than starting from deployment or the previous head.
  assert.deepEqual(scans, [entrypoint.deploymentBlock, finalized]);
  assert.equal(finalizedReads, 2);
});
