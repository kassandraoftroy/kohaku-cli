import assert from "node:assert/strict";
import { it } from "node:test";
import { mkdtempSync, rmSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeFunctionData, encodeFunctionData, parseAbi } from "viem";
import type { Host } from "@kohaku-eth/plugins";
import { decrypt } from "../src/utils/aes-storage.js";
import { tornadoPoolsForAsset } from "../src/utils/tornado-pools.js";
import { requireTornadoShieldPlan } from "../src/utils/tornado-shield-plans.js";
import { isolatedShieldHost, shieldRunJournal, splitTornadoShieldCalls, submitTornadoShieldBatches, type ShieldBatchRun } from "../src/lib/tornado-shield-batches.js";
const pool = tornadoPoolsForAsset(1n, { isEth: true }).find((pool) => pool.denomination === 10n ** 17n)!;
const depositAbi = parseAbi(["function deposit(bytes32 commitment) payable"]);
const approveAbi = parseAbi(["function approve(address spender, uint256 amount) returns (bool)"]);
function fixture(count = 10) {
  const plan = requireTornadoShieldPlan(BigInt(count) * pool.denomination, [pool]);
  const raw = Array.from({ length: count }, (_, index) => ({ to: pool.poolAddress, value: pool.denomination,
    data: encodeFunctionData({ abi: depositAbi, functionName: "deposit", args: [`0x${BigInt(index + 1).toString(16).padStart(64, "0")}`] }) }));
  const batches = splitTornadoShieldCalls(raw, plan);
  const run: ShieldBatchRun = { version: 1, id: "test", chainId: "1", sender: "0x1", amount: plan.amount, status: "prepared",
    batches: batches.map((batch) => ({ amount: batch.amount, calls: batch.calls, status: "not-submitted" })) };
  return { plan, raw, batches, run };
}
it("splits ten unique commitments into 5/5 without preparing again", () => {
  const { batches, raw, plan } = fixture();
  assert.deepEqual(batches.map((batch) => batch.deposits.length), [5, 5]);
  assert.deepEqual(batches.flatMap((batch) => batch.deposits), raw);
  assert.equal(batches.reduce((sum, batch) => sum + batch.amount, 0n), plan.amount);
  assert.throws(() => splitTornadoShieldCalls(raw.slice(1), plan), /deposit count/);
  assert.throws(() => splitTornadoShieldCalls(raw.map(() => raw[0]!), plan), /duplicate Tornado commitments/);
  assert.throws(() => splitTornadoShieldCalls(raw.map((call) => ({ ...call, to: "0x0000000000000000000000000000000000000001" })), plan), /deposit pools/);
});
it("gives each token batch independent exact approvals, with reset for nonzero allowances", () => {
  const { raw, plan } = fixture();
  const token = "0x0000000000000000000000000000000000000002";
  const batches = splitTornadoShieldCalls(raw.map((call) => ({ ...call, value: 0n })), plan, token);
  for (const batch of batches) {
    assert.equal(batch.calls.length, batch.deposits.length + 2);
    assert.deepEqual(batch.calls.slice(0, 2).map((call) => decodeFunctionData({ abi: approveAbi, data: call.data as `0x${string}` }).args),
      [[pool.poolAddress, 0n], [pool.poolAddress, batch.amount]]);
    assert.ok(batch.calls.slice(0, 2).every((call) => call.to === token));
  }
});
it("awaits inclusion before starting the next batch and retains success when the second fails", async () => {
  const { run } = fixture(12);
  const starts: number[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const saved: ShieldBatchRun[] = [];
  const pending = submitTornadoShieldBatches(run, (state) => { saved.push(structuredClone(state)); }, async (_batch, index, submitted) => {
    starts.push(index);
    submitted(`userop-${index}`);
    if (index === 0) { await gate; return { userOpHash: "userop-0", txHash: "tx-0" }; }
    throw Object.assign(new Error("rejected"), { submissionStatus: "failed" });
  });
  assert.deepEqual(starts, [0]);
  release();
  const result = await pending;
  assert.deepEqual(starts, [0, 1]);
  assert.equal(result.status, "partial");
  assert.deepEqual(result.batches.map((batch) => batch.status), ["confirmed", "failed", "not-submitted"]);
  assert.equal(result.batches[0]!.txHash, "tx-0");
  assert.ok(saved.some((state) => state.batches[0]!.status === "confirmed" && state.batches[1]!.status === "not-submitted"));
});
it("stops on an unknown submission and never retries it", async () => {
  const { run } = fixture(); let sends = 0;
  const result = await submitTornadoShieldBatches(run, () => {}, async (_batch, _index, submitted) => {
    sends++; submitted("known-hash"); throw new Error("receipt timeout");
  });
  assert.equal(sends, 1);
  assert.equal(result.batches[0]!.status, "unknown");
  assert.equal(result.batches[0]!.userOpHash, "known-hash");
  await assert.rejects(submitTornadoShieldBatches(run, () => {}, async () => { assert.fail("must not send"); }), /already submitted/);
});
it("does not send anything if prepared commitments cannot be saved", async () => {
  const { run } = fixture();
  await assert.rejects(submitTornadoShieldBatches(run, () => { throw new Error("disk full"); }, async () => { assert.fail("must not send"); }), /disk full/);
});
it("retains a known successful receipt and stops if saving that success fails", async () => {
  const { run } = fixture(); let sends = 0;
  const result = await submitTornadoShieldBatches(run, (state) => {
    if (state.batches[0]!.status === "confirmed") throw new Error("disk full after receipt");
  }, async (_batch, _index, submitted) => { sends++; submitted("hash-0"); return { userOpHash: "hash-0", txHash: "tx-0" }; });
  assert.equal(sends, 1);
  assert.equal(result.batches[0]!.status, "confirmed");
  assert.equal(result.batches[0]!.txHash, "tx-0");
  assert.equal(result.status, "partial");
  assert.match(result.error!, /disk full after receipt/);
});
it("isolates narrowed catalog writes while reading the full synced state", async () => {
  const original = new Map([["state", "all pools"]]);
  const host = { storage: { get: async (key: string) => original.get(key) ?? null, set: async (key: string, value: string) => { original.set(key, value); } } } as Host;
  const selected = isolatedShieldHost(host);
  assert.equal(await selected.storage.get("state"), "all pools");
  await selected.storage.set("state", "one pool");
  assert.equal(await selected.storage.get("state"), "one pool");
  assert.equal(original.get("state"), "all pools");
});
it("persists prepared calls and partial progress encrypted with private file permissions", () => {
  const dir = mkdtempSync(join(tmpdir(), "shield-batches-"));
  try {
    const { run } = fixture(); run.batches[0]!.status = "confirmed"; run.batches[0]!.txHash = "tx-0"; run.status = "partial";
    shieldRunJournal(dir, "password")(run);
    const path = join(dir, "shield-runs", "test.json");
    const text = readFileSync(path, "utf8");
    assert.ok(!text.includes(run.batches[0]!.calls[0]!.data));
    const stored = JSON.parse(decrypt(JSON.parse(text), "password"));
    assert.equal(stored.batches[0].calls[0].data, run.batches[0]!.calls[0]!.data);
    assert.equal(stored.batches[0].status, "confirmed");
    assert.equal(statSync(path).mode & 0o777, 0o600);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
