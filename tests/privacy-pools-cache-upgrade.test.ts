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
  const host = {
    storage: { _brand: "Storage", get: async (key: string) => {
      reads.push(key); return saved.get(key) ?? null;
    }, set: async (key: string, value: string) => { saved.set(key, value); } },
    provider: {
      getChainId: async () => chainId, getBlockNumber: async () => head,
      getLogs: async ({ fromBlock }: { fromBlock: bigint }) => { scans.push(fromBlock); return []; },
      request: async ({ method }: { method: string }) => method === "eth_chainId"
        ? toHex(chainId) : toHex(0n, { size: 32 }),
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
  assert.deepEqual(scans, [entrypoint.deploymentBlock, head]);
});
