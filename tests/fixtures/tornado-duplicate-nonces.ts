// Run in a child process because the published SDK does not expose worker disposal.
import assert from "node:assert/strict";
import type { Host } from "@kohaku-eth/plugins";
import { createTCPlugin, SignatureSecretManager, TornadoCashConfigs, TornadoInstances } from "@kohaku-eth/tornado-cash";
import { encodeAbiParameters, encodeEventTopics, parseAbi, toHex } from "viem";
import { mapTornadoNotes } from "../../src/lib/private-notes.js";
import { listTornadoUnspentNotes, totalTornadoUnspentBalance, type AnyPlugin } from "../../src/utils/plugins.js";
import { selectTornadoWithdrawalNotes } from "../../src/utils/tornado-unshield-pools.js";

async function main() {
  const chainId = 11155111n;
  const instances = TornadoInstances[11155111].slice(0, 2);
  const config = { ...TornadoCashConfigs[11155111], instances };
  const keystore = { deriveAt: async () => `0x${"12".repeat(32)}` as `0x${string}` };
  const manager = await SignatureSecretManager({ host: { keystore } as never, accountIndex: 0 });
  const secrets = await Promise.all(instances.map((pool) => manager.getSignatureSecrets({ chainId, poolAddress: pool.address, nonce: 0 })));
  const state = {
    pools: { poolsTuples: instances.map((pool) => [toHex(pool.address), {
      address: toHex(pool.address), asset: "0x0", isERC20: false, denomination: toHex(pool.denomination),
      protocolFeePercentage: 0, registeredBlock: "0x1", lastSyncedBlock: "0xa", state: 1, rootHistorySize: 100,
    }]) },
    deposits: { depositsTuples: instances.map((pool, index) => [toHex(pool.address), [[toHex(secrets[index]!.commitment), {
      pool: toHex(pool.address), commitment: toHex(secrets[index]!.commitment), leafIndex: 0,
      timestamp: "0x1", blockNumber: "0x1", transactionHash: "0x1",
    }]]]) },
    withdrawals: { withdrawalsTuples: [] },
    sync: { lastSyncedBlock: "0xa", relayerRegistrySyncedBlock: "0xa" },
  };
  const key = `tornado-cash-state-${chainId}-${config.instanceRegistry.address}`;
  const storage = new Map([[key, JSON.stringify(state)]]);
  let spent = false;
  const host = {
    keystore,
    storage: { _brand: "Storage", get: async (key: string) => storage.get(key) ?? null,
      set: async (key: string, value: string) => { storage.set(key, value); } },
    provider: {
      getChainId: async () => chainId,
      getBlockNumber: async () => 10n,
      getLogs: async ({ address }: { address: string }) => spent && BigInt(address) === instances[0]!.address ? [{
        address, blockNumber: 10n, data: encodeAbiParameters([
          { type: "address" }, { type: "bytes32" }, { type: "uint256" },
        ], [toHex(123n, { size: 20 }), toHex(secrets[0]!.nullifierHash, { size: 32 }), 0n]),
        topics: encodeEventTopics({ abi: parseAbi(["event Withdrawal(address to, bytes32 nullifierHash, address indexed relayer, uint256 fee)"]),
          eventName: "Withdrawal", args: { relayer: toHex(0n, { size: 20 }) } }),
      }] : [],
      request: async ({ method }: { method: string }) => {
        if (method === "eth_chainId") return toHex(chainId);
        if (method === "eth_blockNumber") return "0xa";
        assert.equal(method, "eth_call");
        return encodeAbiParameters([{ type: "address[]" }], [instances.map((pool) => toHex(pool.address, { size: 20 }))]);
      },
    },
    network: { fetch: async () => { throw new Error("Unexpected network request"); } },
  } as unknown as Host;
  const plugin = createTCPlugin(host, { accountIndex: 0, protocolConfig: config,
    secretManagerFactory: async () => ({ ...manager,
      getLegacyDepositSecrets: async () => ({ commitment: 1n, nullifierHash: 1n, nullifier: 1n, salt: 1n }),
    }) as never,
  }) as unknown as AnyPlugin;
  const asset = { __type: "erc20" as const, contract: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" as const };
  const notes = await listTornadoUnspentNotes(plugin, asset);
  assert.equal(notes.length, 2, "the installed SDK discovers both pool-specific notes with nonce 0");
  assert.deepEqual(notes.map((note) => note.nonce), [0, 0]);
  const total = instances.reduce((sum, pool) => sum + pool.denomination, 0n);
  assert.equal(await totalTornadoUnspentBalance(plugin, asset), total);
  assert.equal(selectTornadoWithdrawalNotes(notes, total).length, 2, "both notes remain eligible for spending");
  const rows = mapTornadoNotes(notes.map((note) => ({ ...note, derivation: "signature" })), new Map());
  assert.deepEqual(rows.map((row) => row.nonce), ["0", "0"]);
  assert.notEqual(rows[0]!.commitment, rows[1]!.commitment);
  for (const note of notes) {
    const rederived = await manager.getSignatureSecrets({ chainId, poolAddress: note.pool, nonce: note.nonce! });
    assert.equal(rederived.commitment, note.commitment, "export/spend re-derivation keeps each note's original pool and nonce");
  }
  // The sibling note must remain spendable after one of the duplicated nonces is spent.
  spent = true;
  const remaining = await listTornadoUnspentNotes(plugin, asset);
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0]!.pool, instances[1]!.address);
  assert.equal(remaining[0]!.nonce, 0);
}

main().then(() => process.exit(0), (error) => { console.error(error); process.exit(1); });
