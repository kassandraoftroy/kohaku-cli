import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { encodeFunctionData, parseAbi } from "viem";
import type { Host } from "@kohaku-eth/plugins";
import { encrypt, generateSalt } from "../utils/aes-storage.js";
import { jsonStringifyWithBigInt } from "../utils/json-bigint.js";
import { partitionShieldTxs, type ShieldCall } from "./shield-flow.js";
import type { TornadoShieldPlan } from "../utils/tornado-shield-plans.js";
import { TORNADO_SHIELD_NOTES_PER_USEROP } from "../utils/tornado-shield-plans.js";

/** Selection-only SDK instances must never overwrite the fully synced catalog. */
export function isolatedShieldHost(host: Host): Host {
  const local = new Map<string, string>();
  return { ...host, storage: {
    _brand: "Storage",
    get: async (key) => local.has(key) ? local.get(key)! : host.storage.get(key),
    set: async (key, value) => { local.set(key, value); },
  } };
}

export type TornadoShieldBatch = { amount: bigint; deposits: ShieldCall[]; calls: ShieldCall[] };
const approveAbi = parseAbi(["function approve(address spender, uint256 amount) returns (bool)"]);

/** Each batch carries its own exact token approvals; later batches never depend on earlier allowances. */
export function splitTornadoShieldCalls(raw: ShieldCall[], plan: TornadoShieldPlan, tokenAddress?: string): TornadoShieldBatch[] {
  const { deposits } = partitionShieldTxs(raw);
  if (deposits.length !== plan.noteCount) throw new Error("SDK deposit count differs from the selected Tornado plan.");
  if (new Set(deposits.map((call) => `${call.to.toLowerCase()}:${call.data.toLowerCase()}`)).size !== deposits.length) {
    throw new Error("SDK returned duplicate Tornado commitments; nothing was submitted.");
  }
  const expected = new Map(plan.entries.map(({ pool, count }) => [pool.poolAddress.toLowerCase(), { pool, count }]));
  const actual = new Map<string, number>();
  for (const deposit of deposits) actual.set(deposit.to.toLowerCase(), (actual.get(deposit.to.toLowerCase()) ?? 0) + 1);
  if (actual.size !== expected.size || [...expected].some(([address, entry]) => actual.get(address) !== entry.count)) {
    throw new Error("SDK deposit pools differ from the selected Tornado packing.");
  }
  const batches: TornadoShieldBatch[] = [];
  for (let i = 0; i < deposits.length; i += TORNADO_SHIELD_NOTES_PER_USEROP) {
    const chunk = deposits.slice(i, i + TORNADO_SHIELD_NOTES_PER_USEROP);
    const amounts = new Map<string, bigint>();
    for (const deposit of chunk) {
      const pool = expected.get(deposit.to.toLowerCase())!.pool;
      amounts.set(pool.poolAddress, (amounts.get(pool.poolAddress) ?? 0n) + pool.denomination);
    }
    // Reset first for tokens that forbid nonzero-to-nonzero approval. Approvals
    // count as calls, not deposit notes, and are estimated with the whole batch.
    const approvals = tokenAddress ? [...amounts].flatMap(([spender, amount]) => [0n, amount].map((value) => ({
      to: tokenAddress, value: 0n,
      data: encodeFunctionData({ abi: approveAbi, functionName: "approve", args: [spender as `0x${string}`, value] }),
    }))) : [];
    batches.push({ amount: [...amounts.values()].reduce((a, b) => a + b, 0n), deposits: chunk, calls: [...approvals, ...chunk] });
  }
  return batches;
}

export type ShieldBatchProgress = {
  status: "not-submitted" | "submitted" | "confirmed" | "failed" | "unknown";
  amount: bigint; calls: ShieldCall[]; userOpHash?: string; txHash?: string; error?: string;
  delegatedInUserOp?: boolean;
};
export type ShieldBatchRun = {
  version: 1; id: string; chainId: string; sender: string; amount: bigint;
  status: "prepared" | "complete" | "partial" | "failed";
  error?: string;
  batches: ShieldBatchProgress[];
};

/** Persist prepared commitments and receipts before permitting the next send. No private keys are stored. */
export function shieldRunJournal(walletDir: string, password: string) {
  const dir = join(walletDir, "shield-runs");
  return (run: ShieldBatchRun) => {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, `${run.id}.json`);
    const temporary = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(encrypt(jsonStringifyWithBigInt(run), password, generateSalt())), { mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
  };
}

/** `send` must resolve only after a successful receipt, not merely acceptance. */
export async function submitTornadoShieldBatches(
  run: ShieldBatchRun,
  save: (run: ShieldBatchRun) => void,
  send: (batch: ShieldBatchProgress, index: number, submitted: (hash: string) => void) => Promise<{ userOpHash: string; txHash: string; delegatedInUserOp?: boolean }>,
  confirmed?: (batch: ShieldBatchProgress, index: number) => void,
): Promise<ShieldBatchRun> {
  save(run);
  for (let index = 0; index < run.batches.length; index++) {
    const batch = run.batches[index]!;
    // This runner deliberately does not retry saved/ambiguous submissions.
    if (batch.status !== "not-submitted") throw new Error("Shield batch is already submitted; reconcile its receipt before taking further action.");
    let receipt: { userOpHash: string; txHash: string; delegatedInUserOp?: boolean };
    try {
      receipt = await send(batch, index, (hash) => {
        batch.status = "submitted";
        batch.userOpHash = hash;
        save(run);
      });
    } catch (error) {
      batch.error = error instanceof Error ? error.message : String(error);
      const failure = error as { submissionStatus?: string; txHash?: string } | null;
      batch.status = failure?.submissionStatus === "failed" ? "failed" : batch.userOpHash ? "unknown" : "failed";
      if (failure?.txHash) batch.txHash = failure.txHash;
      run.status = run.batches.some((entry) => entry.status === "confirmed") ? "partial" : "failed";
      try { save(run); } catch (journalError) { run.error = `Cannot save stopped shield progress: ${String(journalError)}`; }
      return run;
    }
    batch.status = "confirmed";
    batch.userOpHash = receipt.userOpHash;
    batch.txHash = receipt.txHash;
    batch.delegatedInUserOp = receipt.delegatedInUserOp;
    confirmed?.(batch, index);
    try { save(run); } catch (error) {
      // A receipt remains a success even if the journal disk fills afterwards.
      // Never start another batch before its predecessor's progress is durable.
      run.status = run.batches.every((entry) => entry.status === "confirmed") ? "complete" : "partial";
      run.error = `Cannot save confirmed shield progress: ${String(error)}`;
      return run;
    }
  }
  run.status = "complete";
  try { save(run); } catch (error) { run.error = `Cannot save completed shield progress: ${String(error)}`; }
  return run;
}
