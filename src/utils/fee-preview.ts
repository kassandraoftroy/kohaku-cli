/**
 * Lightweight fee previews for dry-run output and broadcast confirmations.
 * Estimates are upper bounds (maxFee × gas / quoted bps); actual spend is usually lower.
 */
import chalk from "chalk";
import { formatUnits, type Address, type Hex } from "viem";

import type { KohakuPublicClient } from "./rpc.js";

export type FeePreview = {
  kind:
    | "network-gas"
    | "eip7702-userop"
    | "railgun-paymaster"
    | "tornado-paymaster"
    | "privacy-pools-relayer";
  /** Primary fee in asset base units (wei / token raw). */
  estimatedMax: string;
  estimatedMaxFormatted: string;
  asset: string;
  maxFeePerGasWei?: string;
  maxPriorityFeePerGasWei?: string;
  gasLimit?: string;
  relayFeeBps?: string;
  components?: Array<{
    label: string;
    amount: string;
    amountFormatted: string;
    asset: string;
  }>;
  note?: string;
};

export function formatFeeAmount(
  amount: bigint,
  decimals: number,
  symbol: string
): string {
  return `${formatUnits(amount, decimals)} ${symbol}`;
}

/** One-line fee text for confirm prompts. */
export function feeConfirmLine(fees: FeePreview): string {
  const base = `Estimated fee: ${fees.estimatedMaxFormatted}`;
  return fees.note ? `${base} (${fees.note})` : base;
}

/** Print fee lines under a dry-run summary. */
export function printFeePreview(fees: FeePreview): void {
  console.log(chalk.dim(feeConfirmLine(fees)));
  if (fees.components) {
    for (const c of fees.components) {
      console.log(chalk.dim(`  ${c.label}: ${c.amountFormatted}`));
    }
  }
  if (fees.maxFeePerGasWei != null) {
    console.log(chalk.dim(`  maxFeePerGas: ${fees.maxFeePerGasWei} wei`));
  }
  if (fees.gasLimit != null) {
    console.log(chalk.dim(`  gasLimit: ${fees.gasLimit}`));
  }
  if (fees.relayFeeBps != null) {
    console.log(
      chalk.dim(
        `  relayFeeBps: ${fees.relayFeeBps} (${(Number(fees.relayFeeBps) / 100).toFixed(2)}%)`
      )
    );
  }
}

export async function resolveEip1559Fees(
  client: KohakuPublicClient
): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }> {
  const latest = await client.getBlock({ blockTag: "latest" });
  const base = latest.baseFeePerGas ?? 0n;
  let maxFeePerGas = (base * 110n) / 100n;
  const feeData = await client.estimateFeesPerGas();
  if (feeData.maxFeePerGas != null && feeData.maxFeePerGas > maxFeePerGas) {
    maxFeePerGas = feeData.maxFeePerGas;
  }
  if (maxFeePerGas === 0n && feeData.gasPrice != null) {
    maxFeePerGas = feeData.gasPrice;
  }
  let maxPriorityFeePerGas = feeData.maxPriorityFeePerGas ?? 0n;
  if (maxPriorityFeePerGas > maxFeePerGas) {
    maxPriorityFeePerGas = maxFeePerGas;
  }
  return { maxFeePerGas, maxPriorityFeePerGas };
}

/** Estimate max network fee for a single EIP-1559-style transaction. */
export async function estimateEoaTxFeePreview(
  client: KohakuPublicClient,
  tx: { to: string; from: string; data?: string; value?: bigint },
  gasLimitFallback = 100_000n
): Promise<FeePreview> {
  const { maxFeePerGas, maxPriorityFeePerGas } = await resolveEip1559Fees(client);
  let gasLimit = gasLimitFallback;
  let usedFallback = true;
  try {
    gasLimit = await client.estimateGas({
      account: tx.from as Address,
      to: tx.to as Address,
      data: (tx.data ?? "0x") as Hex,
      value: tx.value,
    });
    usedFallback = false;
  } catch {
    // keep fallback
  }

  const estimatedMax = gasLimit * maxFeePerGas;
  return {
    kind: "network-gas",
    estimatedMax: estimatedMax.toString(),
    estimatedMaxFormatted: formatFeeAmount(estimatedMax, 18, "ETH"),
    asset: "ETH",
    maxFeePerGasWei: maxFeePerGas.toString(),
    maxPriorityFeePerGasWei: maxPriorityFeePerGas.toString(),
    gasLimit: gasLimit.toString(),
    note: usedFallback
      ? "gas limit fallback × maxFeePerGas; actual usually lower"
      : "gas limit × maxFeePerGas; actual usually lower",
  };
}

/** Sum several EOA fee previews into one total (same asset). */
export function sumEoaFeePreviews(parts: FeePreview[]): FeePreview {
  if (parts.length === 0) {
    return {
      kind: "network-gas",
      estimatedMax: "0",
      estimatedMaxFormatted: formatFeeAmount(0n, 18, "ETH"),
      asset: "ETH",
    };
  }
  if (parts.length === 1) return parts[0]!;

  let total = 0n;
  let gasSum = 0n;
  let maxFee = 0n;
  const components: NonNullable<FeePreview["components"]> = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    const amt = BigInt(p.estimatedMax);
    total += amt;
    if (p.gasLimit) gasSum += BigInt(p.gasLimit);
    if (p.maxFeePerGasWei) {
      const fee = BigInt(p.maxFeePerGasWei);
      if (fee > maxFee) maxFee = fee;
    }
    components.push({
      label: `tx ${i + 1}`,
      amount: p.estimatedMax,
      amountFormatted: p.estimatedMaxFormatted,
      asset: p.asset,
    });
  }
  return {
    kind: "network-gas",
    estimatedMax: total.toString(),
    estimatedMaxFormatted: formatFeeAmount(total, 18, "ETH"),
    asset: "ETH",
    maxFeePerGasWei: maxFee > 0n ? maxFee.toString() : undefined,
    gasLimit: gasSum > 0n ? gasSum.toString() : undefined,
    components,
    note: "sum of per-tx max estimates; actual usually lower",
  };
}

export function buildFeePreview(opts: {
  kind: FeePreview["kind"];
  amount: bigint;
  decimals: number;
  asset: string;
  maxFeePerGasWei?: bigint;
  gasLimit?: bigint;
  relayFeeBps?: bigint | number | string;
  components?: FeePreview["components"];
  note?: string;
}): FeePreview {
  return {
    kind: opts.kind,
    estimatedMax: opts.amount.toString(),
    estimatedMaxFormatted: formatFeeAmount(
      opts.amount,
      opts.decimals,
      opts.asset
    ),
    asset: opts.asset,
    maxFeePerGasWei: opts.maxFeePerGasWei?.toString(),
    gasLimit: opts.gasLimit?.toString(),
    relayFeeBps:
      opts.relayFeeBps != null ? opts.relayFeeBps.toString() : undefined,
    components: opts.components,
    note: opts.note,
  };
}
