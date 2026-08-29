import { makePublicClient } from "./rpc.js";

/** Hard cap if estimateGas fails; EOA send uses padded estimateGas, not this raw. */
export const SHIELD_GAS_LIMIT = 2_000_000n;

/** 1.3× pad on estimated gas (tx gasLimit) and on gas × maxFee (amount-max reserve). */
export const SHIELD_FEE_PAD_NUM = 13n;
export const SHIELD_FEE_PAD_DEN = 10n;

export function padShieldFeeWei(feeWei: bigint): bigint {
  return (feeWei * SHIELD_FEE_PAD_NUM) / SHIELD_FEE_PAD_DEN;
}

/** estimateGas × 1.3, capped at SHIELD_GAS_LIMIT — this is the gasLimit we put on the tx. */
export function paddedShieldGasLimit(estimatedGas: bigint): bigint {
  if (estimatedGas <= 0n) return SHIELD_GAS_LIMIT;
  const padded = padShieldFeeWei(estimatedGas);
  if (padded > SHIELD_GAS_LIMIT) return SHIELD_GAS_LIMIT;
  return padded < estimatedGas ? estimatedGas : padded;
}

/** First-pass reserve before we have a tx to estimateGas (2M × maxFee × 1.3). */
export function eoaShieldFeeReserveWei(maxFeePerGas: bigint): bigint {
  return padShieldFeeWei(SHIELD_GAS_LIMIT * maxFeePerGas);
}

/**
 * Wei to reserve when refining --amount-max after a live fee preview.
 * Matches the signed tx: padded `estimateGas` × maxFee × 1.3 (not the 2M cap).
 */
export function shieldMaxFeeReserveWei(opts: {
  batch: boolean;
  estimatedMaxWei: bigint;
  maxFeePerGasWei?: bigint;
  /** Raw estimateGas (EOA). When set, reserve uses paddedShieldGasLimit of this. */
  gasLimit?: bigint;
}): bigint {
  if (opts.batch) return padShieldFeeWei(opts.estimatedMaxWei);
  const maxFee = opts.maxFeePerGasWei ?? 0n;
  if (maxFee > 0n) {
    const gas =
      opts.gasLimit != null && opts.gasLimit > 0n
        ? paddedShieldGasLimit(opts.gasLimit)
        : SHIELD_GAS_LIMIT;
    return padShieldFeeWei(gas * maxFee);
  }
  return padShieldFeeWei(opts.estimatedMaxWei);
}

/** Highest maxFeePerGas such that `gasLimit × maxFee + value <= balance`. */
export function maxFeeFittingBalance(opts: {
  gasLimit: bigint;
  value: bigint;
  balance: bigint;
}): bigint | null {
  if (opts.gasLimit === 0n) return null;
  if (opts.balance <= opts.value) return null;
  return (opts.balance - opts.value) / opts.gasLimit;
}

/**
 * Gas + EIP-1559 fees to put on the signed EOA shield.
 * Pins fees (viem must not re-estimate) and, when `balance` is set (--amount-max),
 * caps maxFeePerGas so the node's `gas × maxFee + value` check always passes.
 */
export function eoaShieldSendParams(opts: {
  estimatedGas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  value: bigint;
  balance?: bigint;
}): {
  gas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
} {
  const gas = paddedShieldGasLimit(opts.estimatedGas);
  let maxFeePerGas = opts.maxFeePerGas;
  let maxPriorityFeePerGas = opts.maxPriorityFeePerGas;
  if (opts.balance != null) {
    const fit = maxFeeFittingBalance({
      gasLimit: gas,
      value: opts.value,
      balance: opts.balance,
    });
    if (fit != null && fit > 0n && maxFeePerGas > fit) {
      maxFeePerGas = fit;
    }
  }
  if (maxPriorityFeePerGas > maxFeePerGas) {
    maxPriorityFeePerGas = maxFeePerGas;
  }
  return { gas, maxFeePerGas, maxPriorityFeePerGas };
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
