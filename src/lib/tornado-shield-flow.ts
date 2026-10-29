import { randomUUID } from "node:crypto";
import { confirm } from "@inquirer/prompts";
import { spinner } from "@clack/prompts";
import { formatUnits, erc20Abi } from "viem";
import type { Host } from "@kohaku-eth/plugins";
import { createProtocolPlugin, ETH_AS_ERC20, prepareProtocolShield } from "../utils/plugins.js";
import { assertTornadoShieldCalls, toShieldTxs, tornadoShieldTargetsLine } from "./shield-flow.js";
import { isolatedShieldHost, shieldRunJournal, splitTornadoShieldCalls, submitTornadoShieldBatches, type ShieldBatchRun } from "./tornado-shield-batches.js";
import { estimateEip7702BatchUserOpFee, sendEip7702BatchUserOperation, type Eip7702TorOpts } from "../utils/eip7702-batch-userop.js";
import { buildFeePreview, estimateEoaTxFeePreview, feeConfirmLine, type FeePreview } from "../utils/fee-preview.js";
import { eoaShieldSendParams } from "../utils/shield-max.js";
import { makeWalletClient, sendTransactionAndWait, simulateCallOrThrow } from "../utils/viem-tx.js";
import { logCliJson, manageSpinner } from "../utils/cli-quiet.js";
import { runWithSyncProgress, syncPluginWithProgress } from "../utils/sync-progress.js";
import { isFirstProtocolSync } from "../utils/first-sync.js";
import type { ResolvedTokenMeta } from "../utils/tokens-util.js";
import type { KohakuPublicClient } from "../utils/rpc.js";
import { tornadoShieldPlanLabel, type TornadoShieldPlan } from "../utils/tornado-shield-plans.js";
import { SIMPLE_7702_IMPLEMENTATION } from "../utils/simple-7702.js";

/** Prepare each pool once, estimate all batches, confirm the plan, then await each receipt in order. */
export async function runTornadoShield(opts: {
  host: Host; client: KohakuPublicClient; chainId: bigint; token: ResolvedTokenMeta;
  plan: TornadoShieldPlan; sender: string; privateKey?: string; password: string;
  broadcast: boolean; nonInteractive?: boolean; skipSim?: boolean;
  /** Present for ETH amount-max: reject if actual estimated fees exceed the reserve. */
  ethBalance?: bigint;
} & Eip7702TorOpts): Promise<void> {
  const fmt = (amount: bigint) => `${formatUnits(amount, opts.token.decimals)} ${opts.token.symbol}`;
  if (opts.broadcast && !opts.privateKey) throw new Error("Cannot sign this shield: use a stored wallet account or --from-priv.");
  if (opts.broadcast) {
    const available = opts.token.isEth
      ? await opts.client.getBalance({ address: opts.sender as `0x${string}` })
      : await opts.client.readContract({ address: opts.token.tokenAddress as `0x${string}`, abi: erc20Abi,
          functionName: "balanceOf", args: [opts.sender as `0x${string}`] });
    if (available < opts.plan.amount) throw new Error("Insufficient balance for the complete shield plan. No commitments were prepared.");
  }
  const progress = manageSpinner(spinner(), !!opts.nonInteractive);
  progress.start("Syncing Tornado state and preparing the selected packing...");
  let raw: ReturnType<typeof toShieldTxs>;
  try {
    const full = await createProtocolPlugin("tornado", opts.host, opts.chainId, "signature");
    await runWithSyncProgress({ source: "tornado", firstRun: isFirstProtocolSync(opts.walletDir!, "tornado"), onUpdate: opts.nonInteractive ? undefined : (message) => progress.start(message) },
      () => syncPluginWithProgress(full, "tornado"));
    raw = [];
    for (const { pool, count } of opts.plan.entries) {
      // Prepare each pool exactly once. Restricting just the whole plan's pool
      // catalog is insufficient for non-greedy combinations such as 1 + 4x0.3.
      const selection = await createProtocolPlugin("tornado", isolatedShieldHost(opts.host), opts.chainId, "signature", false, [pool.poolAddress]);
      const operation = await prepareProtocolShield(selection, "tornado", {
        asset: { __type: "erc20", contract: (opts.token.isEth ? ETH_AS_ERC20 : opts.token.tokenAddress) as `0x${string}` },
        amount: pool.denomination * BigInt(count),
      });
      raw.push(...toShieldTxs(operation));
    }
    progress.stop("Tornado packing prepared.");
  } finally { if (progress.active) progress.stop("Tornado preparation stopped."); }
  const targets = assertTornadoShieldCalls(opts.chainId, raw, { ...opts.token, amount: opts.plan.amount });
  const batches = splitTornadoShieldCalls(raw, opts.plan, opts.token.isEth ? undefined : opts.token.tokenAddress);
  const run: ShieldBatchRun = { version: 1, id: randomUUID(), chainId: opts.chainId.toString(), sender: opts.sender, amount: opts.plan.amount,
    status: "prepared", batches: batches.map((batch) => ({ status: "not-submitted", amount: batch.amount, calls: batch.calls })) };
  const save = shieldRunJournal(opts.walletDir!, opts.password);
  // Preserve prepared commitments even if estimation or user confirmation fails.
  save(run);
  const singleEoa = batches.length === 1 && batches[0]!.calls.length === 1;
  const estimates: FeePreview[] = [];
  for (const batch of batches) {
    if (opts.skipSim) {
      estimates.push(buildFeePreview({ kind: singleEoa ? "network-gas" : "eip7702-userop", amount: 0n, decimals: 18, asset: "ETH", note: "simulation skipped" }));
    } else if (singleEoa) {
      const call = batch.calls[0]!;
      await simulateCallOrThrow(opts.client, { ...call, from: opts.sender }, "Shield transaction");
      estimates.push(await estimateEoaTxFeePreview(opts.client, { ...call, from: opts.sender }));
    } else {
      estimates.push(await estimateEip7702BatchUserOpFee({ ...opts, senderAddress: opts.sender, calls: batch.calls }));
    }
  }
  const totalFee = estimates.reduce((sum, fee) => sum + BigInt(fee.estimatedMax), 0n);
  const fees = buildFeePreview({ kind: singleEoa ? "network-gas" : "eip7702-userop", amount: totalFee, decimals: 18, asset: "ETH",
    components: estimates.map((fee, i) => ({ label: `Transaction ${i + 1}`, amount: fee.estimatedMax, amountFormatted: fee.estimatedMaxFormatted, asset: "ETH" })),
    note: opts.skipSim ? "simulation skipped; fees unknown" : "sum of batch fee estimates; later batches are estimated again against current state before sending" });
  if (opts.ethBalance !== undefined && opts.plan.amount + totalFee > opts.ethBalance) {
    throw new Error("The amount-max gas reserve is insufficient for this shield plan. No transactions were submitted. Choose a smaller amount; prepared commitments were saved.");
  }
  if (opts.broadcast) {
    const balance = await opts.client.getBalance({ address: opts.sender as `0x${string}` });
    if (balance < totalFee + (opts.token.isEth ? opts.plan.amount : 0n)) {
      throw new Error("Insufficient ETH for the complete shield plan and its combined estimated fees. Nothing was submitted.");
    }
    if (!opts.token.isEth) {
      const tokens = await opts.client.readContract({ address: opts.token.tokenAddress as `0x${string}`, abi: erc20Abi,
        functionName: "balanceOf", args: [opts.sender as `0x${string}`] });
      if (tokens < opts.plan.amount) throw new Error("Insufficient token balance for the complete shield plan. Nothing was submitted.");
    }
  }
  const transactions = batches.flatMap((batch) => batch.calls.map((call) => ({ ...call, from: opts.sender, value: call.value.toString() })));
  const summary = { ...(!singleEoa ? { mode: batches.length > 1 ? "eip7702-userops" : "eip7702-userop", implementation: SIMPLE_7702_IMPLEMENTATION } : {}), runId: run.id, protocol: "tornado", amount: opts.plan.amount.toString(),
    noteCount: opts.plan.noteCount, batchCount: batches.length, sender: opts.sender, fees };
  const message = `Shield ${fmt(opts.plan.amount)} from ${opts.sender}?\n` +
    `  ${tornadoShieldPlanLabel(opts.plan, opts.token.decimals, opts.token.symbol)}\n` +
    `  ${tornadoShieldTargetsLine(targets, opts.token)}\n` +
    batches.map((batch, i) => `  Transaction ${i + 1}: ${fmt(batch.amount)}, ${batch.deposits.length} notes — ${feeConfirmLine(estimates[i]!)}`).join("\n") +
    `\n  Total ${feeConfirmLine(fees)}\n` +
    (batches.length > 1 ? "  Transactions submit sequentially after successful inclusion. This shield can complete only partially.\n" : "");
  if (!opts.broadcast) {
    if (opts.nonInteractive) logCliJson({ ...summary, status: "prepared", batches: run.batches,
      ...(batches.length === 1 ? singleEoa ? { transactions } : { calls: transactions } : {}) });
    else console.log(`${message}\nPrepared only; nothing submitted. Saved in shield-runs/${run.id}.json.`);
    return;
  }
  if (!opts.nonInteractive && !await confirm({ message, default: false })) return;
  await submitTornadoShieldBatches(run, save, async (batch, _index, submitted) => {
    if (singleEoa) {
      const call = batch.calls[0]!;
      const fee = await estimateEoaTxFeePreview(opts.client, { ...call, from: opts.sender });
      const params = eoaShieldSendParams({ estimatedGas: BigInt(fee.gasLimit!), maxFeePerGas: BigInt(fee.maxFeePerGasWei!),
        maxPriorityFeePerGas: BigInt(fee.maxPriorityFeePerGasWei ?? "0"), value: call.value, balance: opts.ethBalance });
      const hash = await sendTransactionAndWait(makeWalletClient(opts.privateKey!, opts.client, opts.rpcUrl), opts.client, {
        ...call, ...params, to: call.to as `0x${string}`, data: call.data as `0x${string}`,
      });
      return { txHash: hash, userOpHash: "" };
    }
    return sendEip7702BatchUserOperation({ ...opts, privateKey: opts.privateKey!, calls: batch.calls, onSubmitted: submitted });
  }, (batch, index) => {
    if (!opts.nonInteractive) console.log(`Transaction ${index + 1}/${batches.length} confirmed: ${batch.txHash} (${fmt(batch.amount)} shielded)`);
  });
  const shielded = run.batches.filter((batch) => batch.status === "confirmed").reduce((sum, batch) => sum + batch.amount, 0n);
  const unknown = run.batches.some((batch) => batch.status === "unknown");
  const single = run.batches[0]!;
  const singleResult = batches.length === 1 && single.status === "confirmed"
    ? singleEoa ? { transactions: [{ type: "shield", hash: single.txHash }] }
      : { userOpHash: single.userOpHash, txHash: single.txHash, calls: transactions,
          delegation: single.delegatedInUserOp ? "included-in-userop" : "already-set" }
    : {};
  if (opts.nonInteractive) logCliJson({ ...summary, ...singleResult, status: run.status, shieldedAmount: shielded.toString(), unconfirmedAmount: (run.amount - shielded).toString(),
    batches: run.batches, ...(run.error ? { error: run.error } : {}), ...(unknown ? { warning: "A submitted operation has an unresolved receipt. Check its hash before retrying; do not repeat the original shield amount." } : {}) });
  if (!opts.nonInteractive && run.status === "complete") console.log(`Shield complete: ${fmt(shielded)} across ${batches.length} transaction(s).`);
  if (run.error) console.error(run.error);
  if (run.status !== "complete" || run.error) {
    process.exitCode = 1;
    if (!opts.nonInteractive) {
      const failed = run.batches.find((batch) => batch.status === "failed" || batch.status === "unknown");
      console.error(`Stopped at UserOp ${failed?.userOpHash ?? "(not submitted)"}: ${failed?.error?.split("\n")[0] ?? "unknown error"}`);
      if (unknown) console.error("Receipt unresolved. Check the submitted hash before retrying.");
      console.error(`Shield stopped: ${fmt(shielded)} confirmed, ${fmt(run.amount - shielded)} unconfirmed. Progress saved in shield-runs/${run.id}.json. Do not repeat the original amount.`);
    }
  }
}
