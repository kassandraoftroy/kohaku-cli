import { formatUnits } from "viem";
import type { TornadoShieldPlan } from "./tornado-shield-plans.js";

/** Round upward for a readable estimate; exact wei values remain in JSON. */
export function compactShieldFee(wei: bigint): string {
  const step = 10n ** 12n;
  return `~${formatUnits((wei + step - 1n) / step * step, 18)} ETH`;
}

export function tornadoShieldConfirmation(opts: {
  plan: TornadoShieldPlan;
  decimals: number;
  symbol: string;
  sender: string;
  batches: readonly { amount: bigint; noteCount: number; fee: bigint }[];
  feesUnknown?: boolean;
}): string {
  const { plan, decimals, symbol, batches } = opts;
  const fmt = (amount: bigint) => `${formatUnits(amount, decimals)} ${symbol}`;
  const fee = (amount: bigint) => opts.feesUnknown ? "unknown (simulation skipped)" : compactShieldFee(amount);
  return [
    `Deposit ${fmt(plan.amount)} with:`,
    "",
    ...plan.entries.map(({ pool, count }) =>
      `  ${count} x ${fmt(pool.denomination)}`),
    "",
    `  From: ${opts.sender}`,
    "",
    "  Pools:",
    ...plan.entries.map(({ pool }) =>
      `    ${fmt(pool.denomination)} → ${pool.poolAddress}`),
    "",
    ...batches.map((batch, i) =>
      `  Tx ${i + 1}: ${fmt(batch.amount)} · ${batch.noteCount} ${batch.noteCount === 1 ? "note" : "notes"} · fee ${fee(batch.fee)}`),
    ...(batches.length > 1 ? [`  Total est. fee: ${fee(batches.reduce((sum, batch) => sum + batch.fee, 0n))}`] : []),
    "",
    ...(opts.feesUnknown ? [] : ["  Fees are estimates; unused gas is refunded."]),
    ...(batches.length > 1 ? ["  Sent in order; fees re-estimated per tx. Partial completion is possible."] : []),
  ].join("\n");
}
