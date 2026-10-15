import type { UnshieldTailCall } from "../utils/plugins.js";
import {
  minimumTornadoNoteSumCovering,
  tornadoWithdrawalCountForAmount,
} from "../utils/plugins.js";
import {
  estimateTornadoPaymasterFee,
  padTornadoTailForwardFee,
  tornadoWithdrawalCallGasLimit,
} from "../utils/tornado-paymaster-gas.js";
import { encodeTornadoErc20TransferTailCall } from "../utils/tornado-tail-gas.js";

/**
 * One tail that pays `to` exactly `amount`.
 * ETH is a value transfer. Tokens are `token.transfer(to, amount)`.
 */
export function exactTransferTailCall(
  token: { isEth: boolean; tokenAddress: `0x${string}` },
  to: `0x${string}`,
  amount: bigint
): UnshieldTailCall {
  if (amount <= 0n) {
    throw new Error("Transfer amount must be greater than zero.");
  }
  if (token.isEth) {
    return { to, data: "0x", value: amount };
  }
  return encodeTornadoErc20TransferTailCall(token.tokenAddress, to, amount);
}

/**
 * Railgun and Privacy Pools unshield the typed amount. The tail forwards that
 * same amount. Fees stay on the private balance, so the fresh account's
 * estimated leftover is zero (Privacy Pools may still refund unused gas there).
 */
export function planNonTornadoPrivateTransfer(transferAmountWei: bigint): {
  unshieldAmountWei: bigint;
  transferAmountWei: bigint;
  estimatedLeftoverWei: bigint;
} {
  if (transferAmountWei <= 0n) {
    throw new Error("Amount must be greater than zero.");
  }
  return {
    unshieldAmountWei: transferAmountWei,
    transferAmountWei,
    estimatedLeftoverWei: 0n,
  };
}

export type TornadoPrivateTransferCover = {
  unshieldAmountWei: bigint;
  withdrawalCount: number;
  /** Measured execution-tail gas, when the estimator returned one. */
  tailGas?: bigint;
  /** Padded paymaster fee in unshield-asset units (note-selection reserve). */
  paddedFee: bigint;
  /** Unpadded paymaster fee in unshield-asset units (leftover display). */
  estimatedFee: bigint;
};

/**
 * Smallest Tornado note sum that covers `transferAmount` plus the padded
 * paymaster fee. Fee depends on note count and tail gas, so this retries a
 * few times after each gas estimate.
 */
export async function resolveTornadoPrivateTransferCover(opts: {
  noteAmounts: readonly bigint[];
  transferAmount: bigint;
  isErc20: boolean;
  maxFeePerGas: bigint;
  /** Quote a wei fee into token base units. Omit for ETH. */
  quoteFeeWei?: (feeWei: bigint) => Promise<bigint>;
  estimateTailGas: (args: {
    unshieldAmount: bigint;
    extraWithdrawals: number;
  }) => Promise<bigint | undefined>;
}): Promise<TornadoPrivateTransferCover> {
  if (opts.transferAmount <= 0n) {
    throw new Error("Amount must be greater than zero.");
  }

  let extra = 0;
  let tailGas: bigint | undefined;
  let unshieldAmount = 0n;
  let paddedFee = 0n;
  let estimatedFee = 0n;

  for (let i = 0; i < 6; i++) {
    const callGasLimit = tornadoWithdrawalCallGasLimit(
      extra,
      tailGas,
      opts.isErc20
    );
    const feeWei = estimateTornadoPaymasterFee(opts.maxFeePerGas, {
      callGasLimit,
      isERC20: opts.isErc20,
    });
    const paddedWei = padTornadoTailForwardFee(feeWei);
    const nextPadded = opts.quoteFeeWei
      ? await opts.quoteFeeWei(paddedWei)
      : paddedWei;
    const nextEstimated = opts.quoteFeeWei
      ? await opts.quoteFeeWei(feeWei)
      : feeWei;
    const nextUnshield = minimumTornadoNoteSumCovering(
      opts.noteAmounts,
      opts.transferAmount + nextPadded
    );
    const nextCount = tornadoWithdrawalCountForAmount(
      opts.noteAmounts,
      nextUnshield
    );
    const nextExtra = Math.max(0, nextCount - 1);
    // Reprice the fee for the note count before simulating. A two-note
    // withdrawal costs more than the zero-extra guess that found it.
    if (nextExtra !== extra && i < 5) {
      extra = nextExtra;
      unshieldAmount = nextUnshield;
      paddedFee = nextPadded;
      estimatedFee = nextEstimated;
      continue;
    }
    const measured = await opts.estimateTailGas({
      unshieldAmount: nextUnshield,
      extraWithdrawals: nextExtra,
    });
    const stable =
      nextUnshield === unshieldAmount &&
      nextExtra === extra &&
      measured === tailGas &&
      nextPadded === paddedFee;
    unshieldAmount = nextUnshield;
    extra = nextExtra;
    tailGas = measured;
    paddedFee = nextPadded;
    estimatedFee = nextEstimated;
    if (stable) break;
  }

  return {
    unshieldAmountWei: unshieldAmount,
    withdrawalCount: extra + 1,
    tailGas,
    paddedFee,
    estimatedFee,
  };
}
