import assert from "node:assert/strict";
import { it } from "node:test";
import type { Host } from "@kohaku-eth/plugins";
import { SignatureSecretManager as TornadoSecrets, TornadoInstances } from "@kohaku-eth/tornado-cash";
import { SignatureSecretManager as PrivacyPoolsSecrets, PrivacyPoolsV1_0xBow } from "@kohaku-eth/privacy-pools";
import { decodeFunctionData, encodeFunctionData, getAddress, parseAbi, toHex } from "viem";
import { allocateShieldNonces, freshShieldNoteNonces, shieldNonceHistory } from "../src/utils/shield-note-nonces.js";

const host = { keystore: { deriveAt: async () => `0x${"12".repeat(32)}` }, provider: { getBlockNumber: async () => 10n } } as unknown as Host;
const tcAbi = parseAbi(["function deposit(bytes32 commitment) payable"]);
const ppAbi = parseAbi(["function deposit(uint256 precommitment) payable", "function deposit(address asset, uint256 value, uint256 precommitment)"]);
const chainId = 11155111n;
const tcPools = TornadoInstances[11155111];
const poolA = tcPools[0]!.address;
const poolB = tcPools[1]!.address;
const address = (pool: bigint) => toHex(pool, { size: 20 });
const tcCall = (pool: bigint) => ({ to: address(pool), value: 1n,
  data: encodeFunctionData({ abi: tcAbi, functionName: "deposit", args: [toHex(1n, { size: 32 })] }) });

function dump(protocol: "tornado" | "privacy-pools", deposits: unknown[] = [], withdrawals: unknown[] = []) {
  const prefix = protocol === "tornado" ? "tornado-cash-state" : "privacy-pool-state";
  return { [`${prefix}-${chainId}-123`]: {
    deposits: { depositsTuples: deposits }, withdrawals: { withdrawalsTuples: withdrawals },
    pools: { poolsTuples: tcPools.map((pool) => [toHex(pool.address), { lastSyncedBlock: "0xa" }]) },
    sync: { lastSyncedBlock: "0xa" },
  } };
}

it("allocates one sequence across a mixed-pool packing and skips any pool's spent or unspent nonce", async () => {
  const derivations: string[] = [];
  const result = await allocateShieldNonces({
    pools: [1n, 2n, 3n], destinations: [1n, 2n, 1n, 3n],
    commitments: new Set([102n]), // nonce 0 deposited at pool 2
    nullifiers: new Set([1113n]), // nonce 1 spent at pool 3
    derive: async (nonce, pool) => {
      derivations.push(`${nonce}:${pool}`);
      return { commitment: BigInt(100 + nonce * 10) + pool, nullifierHash: BigInt(1100 + nonce * 10) + pool };
    },
  });
  assert.deepEqual(result.map(({ nonce }) => nonce), [2, 3, 4, 5]);
  assert.ok(derivations.includes("0:2"));
  assert.ok(derivations.includes("1:3"));
  assert.ok(derivations.includes("2:3"), "a fresh candidate is checked at every pool");
});

it("checks the proposed cursor against history rather than trusting a local next-index hint", async () => {
  const result = await allocateShieldNonces({ startNonce: 50, pools: [1n, 2n], destinations: [1n],
    commitments: new Set([502n]), nullifiers: new Set<bigint>(),
    derive: async (nonce, pool) => ({ commitment: BigInt(nonce * 10) + pool, nullifierHash: BigInt(nonce + 1000) }),
  });
  assert.equal(result[0]!.nonce, 51);
});

it("fails closed on invalid state, missing history, unknown destinations, or a failed derivation", async () => {
  assert.throws(() => shieldNonceHistory("tornado", {}, chainId), /missing or ambiguous/);
  assert.throws(() => shieldNonceHistory("tornado", dump("tornado", [["0x1", "invalid"]]), chainId), /invalid protocol history/);
  assert.throws(() => shieldNonceHistory("privacy-pools", dump("privacy-pools"), 1n), /missing or ambiguous/);
  assert.throws(() => shieldNonceHistory("tornado", dump("tornado"), chainId, 11n), /not synced through block/);
  assert.throws(() => shieldNonceHistory("privacy-pools", dump("privacy-pools"), chainId, 11n), /history is behind/);
  await assert.rejects(allocateShieldNonces({ pools: [1n], destinations: [2n], commitments: new Set(), nullifiers: new Set(),
    derive: async () => ({ commitment: 1n, nullifierHash: 2n }) }), /outside the freshness scan/);
  await assert.rejects(allocateShieldNonces({ pools: [1n], destinations: [1n], commitments: new Set(), nullifiers: new Set(),
    derive: async () => { throw new Error("signer unavailable"); } }), /signer unavailable/);
});

it("Tornado checks real SDK secrets for a different asset pool and preserves approvals and call values", async () => {
  const manager = await TornadoSecrets({ host, accountIndex: 0 });
  // A deposit made outside the CLI at nonce 0 on an unrelated pool must consume
  // that nonce even when the SDK's discovered wallet-note list is empty/stale.
  const usedPool = tcPools.find((pool) => pool.asset !== tcPools[0]!.asset)!.address;
  const used = await manager.getSignatureSecrets({ chainId, nonce: 0, poolAddress: usedPool });
  const state = dump("tornado", [[toHex(usedPool), [[toHex(used.commitment), { spent: true }]]]]);
  const approval = { to: address(99n), data: "0x095ea7b3", value: 0n };
  let refreshes = 0;
  const calls = await freshShieldNoteNonces({ protocol: "tornado", host, chainId,
    source: { sync: async () => { refreshes++; }, dumpState: () => state },
    calls: [approval, tcCall(poolA), tcCall(poolB), tcCall(poolA)],
  });
  assert.equal(refreshes, 1);
  assert.equal(calls[0], approval);
  for (let i = 1; i < calls.length; i++) {
    const call = calls[i]!;
    const expected = await manager.getSignatureSecrets({ chainId, nonce: i, poolAddress: BigInt(call.to) });
    assert.deepEqual(decodeFunctionData({ abi: tcAbi, data: call.data as `0x${string}` }).args, [toHex(expected.commitment, { size: 32 })]);
    assert.equal(call.value, 1n);
  }
});

it("Tornado rejects a matching nullifier at any pool even without a matching deposit record", async () => {
  const manager = await TornadoSecrets({ host, accountIndex: 0 });
  const spent = await manager.getSignatureSecrets({ chainId, nonce: 0, poolAddress: poolB });
  const state = dump("tornado", [], [[toHex(spent.nullifierHash), {}]]);
  const [call] = await freshShieldNoteNonces({ protocol: "tornado", host, chainId,
    source: { sync: async () => {}, dumpState: () => state }, calls: [tcCall(poolA)],
  });
  const next = await manager.getSignatureSecrets({ chainId, nonce: 1, poolAddress: poolA });
  assert.deepEqual(decodeFunctionData({ abi: tcAbi, data: call!.data as `0x${string}` }).args, [toHex(next.commitment, { size: 32 })]);
});

it("Privacy Pools uses global indexes for ETH/ERC-20, checking unspent deposits and spent nullifiers", async () => {
  const entrypointAddress = BigInt(PrivacyPoolsV1_0xBow[11155111].entrypoint.entrypointAddress);
  const manager = PrivacyPoolsSecrets({ host, accountIndex: 0 });
  const derive = (depositIndex: number) => manager.getDepositSecrets({ chainId, entrypointAddress, depositIndex });
  const used = await derive(0);
  const spent = await derive(1);
  const state = dump("privacy-pools", [[toHex(used.precommitment), { pool: toHex(poolB) }]], [[toHex(spent.nullifierHash), {}]]);
  const calls = await freshShieldNoteNonces({ protocol: "privacy-pools", host, chainId,
    source: { sync: async () => {}, dumpState: () => state }, calls: [
      { to: address(entrypointAddress), value: 42n, data: encodeFunctionData({ abi: ppAbi, functionName: "deposit", args: [1n] }) },
      { to: address(entrypointAddress), value: 0n, data: encodeFunctionData({ abi: ppAbi, functionName: "deposit", args: [address(123n), 99n, 1n] }) },
    ],
  });
  assert.deepEqual(decodeFunctionData({ abi: ppAbi, data: calls[0]!.data as `0x${string}` }).args, [(await derive(2)).precommitment]);
  assert.deepEqual(decodeFunctionData({ abi: ppAbi, data: calls[1]!.data as `0x${string}` }).args, [getAddress(address(123n)), 99n, (await derive(3)).precommitment]);
  assert.deepEqual(calls.map((call) => call.value), [42n, 0n]);
});

it("checks an externally used next nonce even when spent wallet notes supply an advanced cursor", async () => {
  const entrypointAddress = BigInt(PrivacyPoolsV1_0xBow[11155111].entrypoint.entrypointAddress);
  const manager = PrivacyPoolsSecrets({ host, accountIndex: 0 });
  const used = await manager.getDepositSecrets({ chainId, entrypointAddress, depositIndex: 60 });
  const calls = await freshShieldNoteNonces({ protocol: "privacy-pools", host, chainId,
    source: {
      sync: async () => { assert.fail("notes() performs the sync"); },
      notes: async (...args) => { assert.deepEqual(args, [[], true]); return [{ deposit: 59, balance: 0n }]; },
      dumpState: () => dump("privacy-pools", [[toHex(used.precommitment), {}]]),
    },
    calls: [{ to: address(entrypointAddress), value: 10n, data: encodeFunctionData({ abi: ppAbi, functionName: "deposit", args: [1n] }) }],
  });
  const next = await manager.getDepositSecrets({ chainId, entrypointAddress, depositIndex: 61 });
  assert.deepEqual(decodeFunctionData({ abi: ppAbi, data: calls[0]!.data as `0x${string}` }).args, [next.precommitment]);
});

it("refreshes again after an externally submitted deposit and keeps protocol sequences separate", async () => {
  const entrypointAddress = BigInt(PrivacyPoolsV1_0xBow[11155111].entrypoint.entrypointAddress);
  const manager = PrivacyPoolsSecrets({ host, accountIndex: 0 });
  const zero = await manager.getDepositSecrets({ chainId, entrypointAddress, depositIndex: 0 });
  let state = dump("privacy-pools");
  let refreshes = 0;
  const prepare = () => freshShieldNoteNonces({ protocol: "privacy-pools", host, chainId,
    source: { sync: async () => { refreshes++; }, dumpState: () => state },
    calls: [{ to: address(entrypointAddress), value: 10n, data: encodeFunctionData({ abi: ppAbi, functionName: "deposit", args: [1n] }) }],
  });
  const first = await prepare();
  state = dump("privacy-pools", [[toHex(zero.precommitment), {}]]);
  const second = await prepare();
  assert.notEqual(first[0]!.data, second[0]!.data);
  assert.equal(refreshes, 2);
  const tcManager = await TornadoSecrets({ host, accountIndex: 0 });
  const tornado = await freshShieldNoteNonces({ protocol: "tornado", host, chainId,
    source: { sync: async () => {}, dumpState: () => dump("tornado") }, calls: [tcCall(poolA)],
  });
  const tcZero = await tcManager.getSignatureSecrets({ chainId, nonce: 0, poolAddress: poolA });
  assert.deepEqual(decodeFunctionData({ abi: tcAbi, data: tornado[0]!.data as `0x${string}` }).args, [toHex(tcZero.commitment, { size: 32 })]);
});
