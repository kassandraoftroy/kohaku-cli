import { makePublicClient } from "./rpc.js";

/** Same gas cap shield uses when broadcasting a single EOA deposit. */
export const SHIELD_GAS_LIMIT = 2_000_000n;

/** 1.3× pad on gas × maxFee so --amount-max survives fee ticks before send. */
export const SHIELD_FEE_PAD_NUM = 13n;
export const SHIELD_FEE_PAD_DEN = 10n;

export function padShieldFeeWei(feeWei: bigint): bigint {
  return (feeWei * SHIELD_FEE_PAD_NUM) / SHIELD_FEE_PAD_DEN;
}

/** Node checks `gasLimit × maxFee + value`; EOA broadcast pins gas to SHIELD_GAS_LIMIT. */
export function eoaShieldFeeReserveWei(maxFeePerGas: bigint): bigint {
  return padShieldFeeWei(SHIELD_GAS_LIMIT * maxFeePerGas);
}

/**
 * Wei to reserve when refining --amount-max after a live fee preview.
 * EOA must not use a tighter `estimateGas` — the signed tx still sets
 * `gas: SHIELD_GAS_LIMIT`, and the node charges the full limit at submission.
 */
export function shieldMaxFeeReserveWei(opts: {
  batch: boolean;
  estimatedMaxWei: bigint;
  maxFeePerGasWei?: bigint;
}): bigint {
  if (!opts.batch && opts.maxFeePerGasWei != null && opts.maxFeePerGasWei > 0n) {
    const fromLimit = eoaShieldFeeReserveWei(opts.maxFeePerGasWei);
    const fromEstimate = padShieldFeeWei(opts.estimatedMaxWei);
    return fromLimit > fromEstimate ? fromLimit : fromEstimate;
  }
  return padShieldFeeWei(opts.estimatedMaxWei);
}

/**
 * Conservative wei reserve for a shield (gas × fee × pad).
 * Uses ~110% of latest base fee, same pattern as transfer --amount-max.
 */
export async function estimateShieldGasReserveWei(
  rpcUrl: string
): Promise<bigint> {
  const client = await makePublicClient(rpcUrl);
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
  if (maxFeePerGas === 0n) {
    throw new Error(
      "Could not determine gas price to compute shield --amount-max."
    );
  }
  return eoaShieldFeeReserveWei(maxFeePerGas);
}

/** Floor `amount` down to a multiple of `minDenom` (0 if amount < min). */
export function tornadoFloorToMinDenom(
  amount: bigint,
  minDenom: bigint
): bigint {
  if (minDenom <= 0n || amount < minDenom) return 0n;
  return amount - (amount % minDenom);
}

export type ComputeShieldMaxAmountOpts = {
  isEth: boolean;
  protocol: string;
  tokenBalance: bigint;
  ethBalance: bigint;
  gasReserveWei: bigint;
  minDenom?: bigint;
};

/**
 * First-pass max shield amount: reserve gas, then (Tornado) floor to min denom.
 * ERC-20 uses the token balance; ETH uses ethBalance - reserve.
 * Returns 0 when the account cannot cover gas, or Tornado leftover is below min denom.
 */
export function computeShieldMaxAmount(
  opts: ComputeShieldMaxAmountOpts
): { amount: bigint; gasReserveWei: bigint } {
  const isTornado = opts.protocol === "tornado";
  const minDenom = opts.minDenom ?? 0n;
  const floor = (raw: bigint): bigint =>
    isTornado && minDenom > 0n ? tornadoFloorToMinDenom(raw, minDenom) : raw;

  if (opts.ethBalance < opts.gasReserveWei) {
    return { amount: 0n, gasReserveWei: opts.gasReserveWei };
  }

  if (!opts.isEth) {
    const raw = opts.tokenBalance > 0n ? opts.tokenBalance : 0n;
    return { amount: floor(raw), gasReserveWei: opts.gasReserveWei };
  }

  const spendable = opts.ethBalance - opts.gasReserveWei;
  return { amount: floor(spendable), gasReserveWei: opts.gasReserveWei };
}

export type RefineShieldMaxAmountOpts = {
  isEth: boolean;
  protocol: string;
  currentAmount: bigint;
  ethBalance: bigint;
  estimatedFeeWei: bigint;
  minDenom?: bigint;
};

/**
 * After a real fee estimate: shrink ETH amount if value + fee exceeds balance.
 * ERC-20 never shrinks the token amount; returns 0 when ETH cannot cover the fee.
 */
export function refineShieldMaxAmount(opts: RefineShieldMaxAmountOpts): bigint {
  const isTornado = opts.protocol === "tornado";
  const minDenom = opts.minDenom ?? 0n;
  const floor = (raw: bigint): bigint =>
    isTornado && minDenom > 0n ? tornadoFloorToMinDenom(raw, minDenom) : raw;

  if (!opts.isEth) {
    return opts.ethBalance < opts.estimatedFeeWei ? 0n : opts.currentAmount;
  }

  if (opts.currentAmount + opts.estimatedFeeWei <= opts.ethBalance) {
    return opts.currentAmount;
  }
  const spendable =
    opts.ethBalance > opts.estimatedFeeWei
      ? opts.ethBalance - opts.estimatedFeeWei
      : 0n;
  return floor(spendable);
}
