import { chainConfig } from "@kohaku-eth/railgun";

import { fetchPimlicoMaxFeePerGas } from "./pimlico-gas.js";
import { railgunPimlicoBundlerUrl } from "./rpc.js";
import { wethAddressForChain } from "./tokens-util.js";

/**
 * Conservative ERC-4337 gas units for a Railgun unshield UserOp (proof + privacy
 * paymaster + optional WETH unwrap). Used only to reserve headroom for max amount;
 * the SDK still estimates the real fee at broadcast time.
 */
export const RAILGUN_UNSHIELD_GAS_UNITS = {
  preVerificationGas: 100_000n,
  verificationGasLimit: 150_000n,
  callGasLimit: 2_500_000n,
  /** Extra call gas when unwrapping WETH → ETH via tail call. */
  nativeUnwrapCallGas: 80_000n,
  paymasterVerificationGasLimit: 400_000n,
  paymasterPostOpGasLimit: 120_000n,
} as const;

const BPS_DENOMINATOR = 10_000n;

/** True when this unshield spends the same asset Railgun uses to pay bundler fees (WETH). */
export function isRailgunFeeToken(
  tokenMeta: { isEth: boolean; tokenAddress: string },
  chainId: bigint
): boolean {
  if (tokenMeta.isEth) return true;
  const chain = chainConfig(chainId);
  const wrapped =
    chain?.wrappedBaseToken?.toLowerCase() ??
    wethAddressForChain(chainId)?.toLowerCase();
  if (!wrapped) return false;
  return tokenMeta.tokenAddress.toLowerCase() === wrapped;
}

/** Gas × maxFeePerGas × 1.2 safety margin (same pattern as Tornado paymaster estimate). */
export function estimateRailgunBundlerFeeWei(
  maxFeePerGas: bigint,
  opts?: { nativeUnwrap?: boolean }
): bigint {
  const callGas =
    RAILGUN_UNSHIELD_GAS_UNITS.callGasLimit +
    (opts?.nativeUnwrap ? RAILGUN_UNSHIELD_GAS_UNITS.nativeUnwrapCallGas : 0n);
  const requiredGas =
    RAILGUN_UNSHIELD_GAS_UNITS.verificationGasLimit +
    callGas +
    RAILGUN_UNSHIELD_GAS_UNITS.paymasterVerificationGasLimit +
    RAILGUN_UNSHIELD_GAS_UNITS.preVerificationGas +
    RAILGUN_UNSHIELD_GAS_UNITS.paymasterPostOpGasLimit;
  return (requiredGas * maxFeePerGas * 12n) / 10n;
}

/**
 * Max amount to pass to `prepareUnshield` (what the recipient should receive).
 * Railgun adds the treasury unshield fee on top of this amount when draining notes.
 */
export function railgunMaxReceivableFromBalance(
  balance: bigint,
  unshieldFeeBps: number,
  reservedFeeTokenWei: bigint
): bigint {
  if (balance <= reservedFeeTokenWei) return 0n;
  const afterReserve = balance - reservedFeeTokenWei;
  const feeBps = BigInt(unshieldFeeBps);
  if (feeBps >= BPS_DENOMINATOR) return 0n;
  return (afterReserve * (BPS_DENOMINATOR - feeBps)) / BPS_DENOMINATOR;
}

export function railgunUnshieldFeeBps(chainId: bigint): number {
  const chain = chainConfig(chainId);
  if (!chain) {
    throw new Error(
      `Railgun is not supported on chainId ${chainId.toString()}.`
    );
  }
  return chain.unshieldFeeBps;
}

/**
 * Fetch bundler gas price and compute max receivable for a Railgun unshield.
 * When the asset is not the fee token, only the treasury BPS fee is deducted.
 */
export async function computeRailgunMaxUnshieldAmount(opts: {
  chainId: bigint;
  balance: bigint;
  tokenMeta: { isEth: boolean; tokenAddress: string };
}): Promise<{
  amount: bigint;
  estimatedGasFeeWei: bigint;
  unshieldFeeBps: number;
}> {
  const unshieldFeeBps = railgunUnshieldFeeBps(opts.chainId);
  const paysGasFromBalance = isRailgunFeeToken(opts.tokenMeta, opts.chainId);

  let estimatedGasFeeWei = 0n;
  if (paysGasFromBalance) {
    const maxFeePerGas = await fetchPimlicoMaxFeePerGas(
      railgunPimlicoBundlerUrl(opts.chainId)
    );
    estimatedGasFeeWei = estimateRailgunBundlerFeeWei(maxFeePerGas, {
      nativeUnwrap: opts.tokenMeta.isEth,
    });
  }

  const amount = railgunMaxReceivableFromBalance(
    opts.balance,
    unshieldFeeBps,
    estimatedGasFeeWei
  );
  return { amount, estimatedGasFeeWei, unshieldFeeBps };
}
