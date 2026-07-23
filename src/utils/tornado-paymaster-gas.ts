import { fetchPimlicoMaxFeePerGas } from "./pimlico-gas.js";

/** SDK `baseGasUnits.callGasLimit` when paymaster `tailCalls` are set. */
const TORNADO_BASE_CALL_GAS_LIMIT = 300_000n;

/** SDK `PER_DIRECT_WITHDRAW_GAS` (ETH pools). */
const TORNADO_PER_DIRECT_WITHDRAW_GAS = 400_000n;

/** SDK `PER_DIRECT_WITHDRAW_GAS_ERC20`. */
const TORNADO_PER_DIRECT_WITHDRAW_GAS_ERC20 = 500_000n;

const TORNADO_PAYMASTER_GAS_UNITS = {
  preVerificationGas: 80_000n,
  verificationGasLimit: 50_000n,
  paymasterVerificationGasLimit: 350_000n,
  paymasterPostOpGasLimit: 50_000n,
} as const;

const ERC20_TRANSFER_GAS = 100_000n;

/**
 * Mirrors SDK `reasonableGasUnitsForBatch` callGasLimit.
 * `executionTail` is user `tailCalls` gas (SDK `tailCallsGasEstimate`); defaults to
 * the static 300k baseline when omitted.
 */
export function tornadoWithdrawalCallGasLimit(
  extraWithdrawals: number,
  executionTail?: bigint,
  isERC20 = false
): bigint {
  const perWithdraw = isERC20
    ? TORNADO_PER_DIRECT_WITHDRAW_GAS_ERC20
    : TORNADO_PER_DIRECT_WITHDRAW_GAS;
  const withdrawalGas = BigInt(Math.max(0, extraWithdrawals)) * perWithdraw;
  return withdrawalGas + (executionTail ?? TORNADO_BASE_CALL_GAS_LIMIT);
}

/** Mirrors tornado-cash `computeMinimumViableFee` (incl. SDK 1.2× safety margin). */
export function estimateTornadoPaymasterFee(
  maxFeePerGas: bigint,
  opts?: { callGasLimit?: bigint; isERC20?: boolean }
): bigint {
  const callGasLimit = opts?.callGasLimit ?? TORNADO_BASE_CALL_GAS_LIMIT;
  const isERC20 = opts?.isERC20 ?? false;
  const units = {
    ...TORNADO_PAYMASTER_GAS_UNITS,
    callGasLimit,
    paymasterVerificationGasLimit: isERC20
      ? TORNADO_PAYMASTER_GAS_UNITS.paymasterVerificationGasLimit +
        ERC20_TRANSFER_GAS
      : TORNADO_PAYMASTER_GAS_UNITS.paymasterVerificationGasLimit,
  };
  const requiredGas =
    units.verificationGasLimit +
    units.callGasLimit +
    units.paymasterVerificationGasLimit +
    units.preVerificationGas +
    units.paymasterPostOpGasLimit;
  return (requiredGas * maxFeePerGas * 12n) / 10n;
}

export async function resolveTornadoPrepareMaxFeePerGas(
  chainId: bigint
): Promise<bigint> {
  const { railgunPimlicoBundlerUrl } = await import("./rpc.js");
  return fetchPimlicoMaxFeePerGas(railgunPimlicoBundlerUrl(chainId));
}
