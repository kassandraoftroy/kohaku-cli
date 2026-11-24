// Run in a child process because the published SDK does not expose worker disposal.
import assert from "node:assert/strict";
import type { Host } from "@kohaku-eth/plugins";
import { createTCPlugin, SignatureSecretManager, TornadoCashConfigs, TornadoInstances } from "@kohaku-eth/tornado-cash";
import { computeMimcMerkleTreeRoot } from "@kohaku-eth/mimc-tree";
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, parseAbi, toHex } from "viem";
import { mapTornadoNotes } from "../../src/lib/private-notes.js";
import { createProtocolPlugin, listTornadoUnspentNotes, totalTornadoUnspentBalance, type AnyPlugin } from "../../src/utils/plugins.js";
import { prefixStorage, SIGNATURE_STORAGE_PREFIX } from "../../src/utils/derivation-scheme.js";
import { tornadoSignatureNonceStorage, withTornadoNonceReservation } from "../../src/utils/tornado-signature-nonces.js";
import { selectTornadoWithdrawalNotes } from "../../src/utils/tornado-unshield-pools.js";

async function main() {
  const reservedScenario = process.argv.includes("--reserved-nonce");
  const nonces = reservedScenario ? [31, 0] : [0, 0];
  const chainId = 11155111n;
  const instances = TornadoInstances[11155111].slice(0, 2);
  const config = { ...TornadoCashConfigs[11155111], instances };
  const keystore = { deriveAt: async () => `0x${"12".repeat(32)}` as `0x${string}` };
  const manager = await SignatureSecretManager({ host: { keystore } as never, accountIndex: 0 });
  const secrets = await Promise.all(instances.map((pool, index) => manager.getSignatureSecrets({ chainId, poolAddress: pool.address, nonce: nonces[index]! })));
  const roots = secrets.map(({ commitment }) => computeMimcMerkleTreeRoot([commitment]));
  const head = 10_000n;
  const finalized = 9_900n;
  const depositBlock = 3_000n;
  const state = {
    pools: { poolsTuples: instances.map((pool) => [toHex(pool.address), {
      address: toHex(pool.address), asset: "0x0", isERC20: false, denomination: toHex(pool.denomination),
      protocolFeePercentage: 0, registeredBlock: "0x1", lastSyncedBlock: toHex(head), state: 1, rootHistorySize: 100,
    }]) },
    deposits: { depositsTuples: instances.map((pool, index) => [toHex(pool.address), [[toHex(secrets[index]!.commitment), {
      pool: toHex(pool.address), commitment: toHex(secrets[index]!.commitment), leafIndex: 0,
      timestamp: "0x1", blockNumber: toHex(depositBlock), transactionHash: "0x1",
    }]]]) },
    withdrawals: { withdrawalsTuples: [] },
    assets: { assetsTuples: [["0x0", { address: "0x0", name: "Ether", symbol: "ETH", decimals: 18 }]] },
    relayers: { relayersTuples: [] },
    sync: { lastSyncedBlock: toHex(head), relayerRegistrySyncedBlock: toHex(head) },
  };
  const key = `tornado-cash-state-${chainId}-${config.instanceRegistry.address}`;
  const persistedKey = reservedScenario ? `${SIGNATURE_STORAGE_PREFIX}${key}` : key;
  const storage = new Map([[persistedKey, JSON.stringify(state)]]);
  let spent = false;
  const ranges: Array<{ address: string; fromBlock: bigint; toBlock: bigint }> = [];
  const calls = parseAbi([
    "function getAllInstanceAddresses() view returns (address[])",
    "function getLastRoot() view returns (bytes32)",
    "function nextIndex() view returns (uint32)",
  ]);
  const host = {
    keystore,
    storage: { _brand: "Storage", get: async (key: string) => storage.get(key) ?? null,
      set: async (key: string, value: string) => { storage.set(key, value); } },
    provider: {
      getChainId: async () => chainId,
      getBlockNumber: async () => head,
      getLogs: async ({ address, fromBlock, toBlock }: { address: string; fromBlock: bigint; toBlock: bigint }) => {
        const poolIndex = instances.findIndex((pool) => pool.address === BigInt(address));
        if (poolIndex === -1) return [];
        ranges.push({ address, fromBlock, toBlock });
        const deposits = fromBlock <= depositBlock && toBlock >= depositBlock ? [{
          address, blockNumber: depositBlock,
          data: encodeAbiParameters([{ type: "uint32" }, { type: "uint256" }], [0, 1n]),
          topics: encodeEventTopics({ abi: parseAbi(["event Deposit(bytes32 indexed commitment, uint32 leafIndex, uint256 timestamp)"]),
            eventName: "Deposit", args: { commitment: toHex(secrets[poolIndex]!.commitment, { size: 32 }) } }),
        }] : [];
        const withdrawals = spent && poolIndex === 0 && fromBlock <= head && toBlock >= head ? [{
          address, blockNumber: head, data: encodeAbiParameters([
            { type: "address" }, { type: "bytes32" }, { type: "uint256" },
          ], [toHex(123n, { size: 20 }), toHex(secrets[0]!.nullifierHash, { size: 32 }), 0n]),
          topics: encodeEventTopics({ abi: parseAbi(["event Withdrawal(address to, bytes32 nullifierHash, address indexed relayer, uint256 fee)"]),
            eventName: "Withdrawal", args: { relayer: toHex(0n, { size: 20 }) } }),
        }] : [];
        return [...deposits, ...withdrawals];
      },
      request: async ({ method, params }: { method: string; params: any[] }) => {
        if (method === "eth_chainId") return toHex(chainId);
        if (method === "eth_blockNumber") return toHex(head);
        if (method === "eth_getBlockByNumber") {
          assert.deepEqual(params, ["finalized", false]);
          return { number: toHex(finalized) };
        }
        assert.equal(method, "eth_call");
        const decoded = decodeFunctionData({ abi: calls, data: params[0].data });
        if (decoded.functionName === "getAllInstanceAddresses") {
          return encodeAbiParameters([{ type: "address[]" }], [instances.map((pool) => toHex(pool.address, { size: 20 }))]);
        }
        assert.equal(params[1], toHex(head), "leaf count and root use the scanned head");
        if (decoded.functionName === "nextIndex") return encodeAbiParameters([{ type: "uint32" }], [1]);
        const poolIndex = instances.findIndex((pool) => pool.address === BigInt(params[0].to));
        assert.notEqual(poolIndex, -1);
        return encodeAbiParameters([{ type: "bytes32" }], [toHex(roots[poolIndex]!, { size: 32 })]);
      },
    },
    network: { fetch: async () => { throw new Error("Unexpected network request"); } },
  } as unknown as Host;
  if (reservedScenario) {
    const signatureStorage = tornadoSignatureNonceStorage(prefixStorage(host.storage, SIGNATURE_STORAGE_PREFIX));
    await withTornadoNonceReservation(signatureStorage, key, async (nextNonce) => {
      assert.equal(nextNonce, 0);
      return { value: undefined, nextNonce: 32 };
    });
    // A worker that loaded the snapshot before allocation must not erase it.
    await signatureStorage.set(key, JSON.stringify(state));
    assert.equal(JSON.parse(storage.get(persistedKey)!).signatureNonces.nextNonce, 32);
  }
  const plugin = reservedScenario
    ? await createProtocolPlugin("tornado", host, chainId, "signature", false, instances.map((pool) => toHex(pool.address, { size: 20 })))
    : createTCPlugin(host, { accountIndex: 0, protocolConfig: config,
    secretManagerFactory: async () => ({ ...manager,
      getLegacyDepositSecrets: async () => ({ commitment: 1n, nullifierHash: 1n, nullifier: 1n, salt: 1n }),
    }) as never,
  }) as unknown as AnyPlugin;
  const asset = { __type: "erc20" as const, contract: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" as const };
  const notes = await listTornadoUnspentNotes(plugin, asset);
  assert.ok(ranges.length >= instances.length);
  for (const pool of instances) {
    const poolRanges = ranges.filter(({ address }) => BigInt(address) === pool.address);
    assert.equal(poolRanges[0]!.fromBlock, head - 7_200n, "old cursors rewind 7,200 blocks");
    assert.equal(poolRanges.at(-1)!.toBlock, head);
    for (let index = 1; index < poolRanges.length; index++) {
      assert.equal(poolRanges[index]!.fromBlock, poolRanges[index - 1]!.toBlock + 1n, "log pages are contiguous without duplicate boundaries");
    }
  }
  const migrated = JSON.parse(storage.get(persistedKey)!);
  assert.ok(migrated.pools.poolsTuples.every(([, pool]: [string, { finalizedBlock: string }]) => BigInt(pool.finalizedBlock) === finalized));
  if (reservedScenario) {
    assert.equal(migrated.signatureNonces.nextNonce, 32, "sync preserves the reserved high-water mark");
    assert.equal(storage.has(key), false, "signature plugin reads and writes only its prefixed SDK state");
  }
  ranges.length = 0;
  assert.equal(notes.length, 2, "the installed SDK discovers both pool-specific notes after loading saved state");
  for (const [index, pool] of instances.entries()) {
    assert.equal(notes.find((note) => note.pool === pool.address)!.nonce, nonces[index]);
  }
  const total = instances.reduce((sum, pool) => sum + pool.denomination, 0n);
  assert.equal(await totalTornadoUnspentBalance(plugin, asset), total);
  assert.equal(selectTornadoWithdrawalNotes(notes, total).length, 2, "both notes remain eligible for spending");
  const rows = mapTornadoNotes(notes.map((note) => ({ ...note, derivation: "signature" })), new Map());
  assert.deepEqual(rows.map((row) => row.nonce).sort(), nonces.map(String).sort());
  assert.notEqual(rows[0]!.commitment, rows[1]!.commitment);
  for (const note of notes) {
    const rederived = await manager.getSignatureSecrets({ chainId, poolAddress: note.pool, nonce: note.nonce! });
    assert.equal(rederived.commitment, note.commitment, "export/spend re-derivation keeps each note's original pool and nonce");
  }
  // The sibling note must remain spendable after one of the duplicated nonces is spent.
  spent = true;
  const remaining = await listTornadoUnspentNotes(plugin, asset);
  assert.ok(ranges.every(({ fromBlock, toBlock }) => fromBlock === finalized && toBlock === head), "subsequent syncs resume from finality");
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0]!.pool, instances[1]!.address);
  assert.equal(remaining[0]!.nonce, 0);
}

main().then(() => process.exit(0), (error) => { console.error(error); process.exit(1); });
