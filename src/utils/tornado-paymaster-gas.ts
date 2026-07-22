import { fetchPimlicoMaxFeePerGas } from "./pimlico-gas.js";

/** SDK `baseGasUnits.callGasLimit` when paymaster `tailCalls` are set. */
const TORNADO_BASE_CALL_GAS_LIMIT = 300_000n;

/** SDK `PER_DIRECT_WITHDRAW_GAS` (ETH pools). */
const TORNADO_PER_DIRECT_WITHDRAW_GAS = 400_000n;

const TORNADO_PAYMASTER_GAS_UNITS = {
  preVerificationGas: 80_000n,
  verificationGasLimit: 50_000n,
  paymasterVerificationGasLimit: 350_000n,
  // PrivacyPaymaster postOp only refunds unused fee (ETH/ERC20); Tornado withdraw runs in
  // TornadoFeeAdapter.collectFee during paymaster validation (see privacy-paymaster tests: 50k).
  paymasterPostOpGasLimit: 50_000n,
} as const;

const ERC20_TRANSFER_GAS = 100_000n;

/**
 * Mirrors SDK `reasonableGasUnitsForBatch` callGasLimit (ETH, tailCalls present).
 * Used only to reserve paymaster fee before prepare when building `tailCalls` forward value.
 */
export function tornadoWithdrawalCallGasLimit(extraWithdrawals: number): bigint {
  const withdrawalGas =
    BigInt(Math.max(0, extraWithdrawals)) * TORNADO_PER_DIRECT_WITHDRAW_GAS;
  return withdrawalGas + TORNADO_BASE_CALL_GAS_LIMIT;
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
