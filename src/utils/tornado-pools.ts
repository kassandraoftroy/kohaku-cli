/**
 * Tornado pool metadata from the installed SDK's static instance catalog.
 * Only instances supported by the SDK's paymaster configuration are available
 * for CLI shields and unshields.
 */
import { formatUnits, getAddress, type Address } from "viem";
import { extendedEthPoolSet, TornadoInstances, TornadoPaymasterConfigs } from "@kohaku-eth/tornado-cash";

export type TornadoSagaPool = {
  poolAddress: Address;
  denomination: bigint;
  asset: string;
  decimals: number;
  isERC20: boolean;
  /** Extended ETH pool introduced in v0.0.12. */
  isNew?: boolean;
  /** Present for ERC-20 pools; omitted for ETH. */
  assetAddress?: Address;
};

/** SDK catalog intersected with paymaster support; no RPC discovery. */
export function tornadoPoolsForChain(chainId: bigint): TornadoSagaPool[] {
  const instances = TornadoInstances[Number(chainId) as keyof typeof TornadoInstances] ?? [];
  const extended = extendedEthPoolSet(chainId);
  const supported = tornadoPaymasterPoolAddresses(chainId);
  const address = (value: bigint): Address =>
    getAddress(`0x${value.toString(16).padStart(40, "0")}`);
  return instances.filter((instance) => supported.has(address(instance.address).toLowerCase())).map((instance) => ({
    poolAddress: address(instance.address),
    denomination: instance.denomination,
    asset: instance.symbol,
    decimals: instance.decimals,
    isERC20: instance.asset !== 0n,
    ...(instance.asset !== 0n ? { assetAddress: address(instance.asset) } : {}),
    ...(extended.has(instance.address) ? { isNew: true } : {}),
  }));
}

export function tornadoPoolsForAsset(
  chainId: bigint,
  opts: { isEth: boolean; tokenAddress?: string; excludeNewPools?: boolean }
): TornadoSagaPool[] {
  const pools = tornadoPoolsForChain(chainId).filter((pool) => !opts.excludeNewPools || !pool.isNew);
  if (opts.isEth) {
    return pools.filter((p) => !p.isERC20);
  }
  const token = opts.tokenAddress?.toLowerCase();
  if (!token) return [];
  return pools.filter(
    (p) =>
      p.isERC20 &&
      p.assetAddress != null &&
      p.assetAddress.toLowerCase() === token
  );
}

/** Throws if this ERC-20 (or ETH) has no Tornado pools in the static catalog. */
export function assertTornadoTokenSupported(
  chainId: bigint,
  opts: { isEth: boolean; tokenAddress: string; symbol: string; excludeNewPools?: boolean }
): TornadoSagaPool[] {
  const pools = tornadoPoolsForAsset(chainId, opts);
  if (pools.length === 0) {
    throw new Error(
      opts.isEth
        ? `Tornado Cash has no ETH pools on chainId ${chainId.toString()}.`
        : `Token ${opts.symbol} (${opts.tokenAddress}) is not in the Tornado Cash pool catalog for chainId ${chainId.toString()}.`
    );
  }
  return pools;
}

/** Smallest pool denomination for this asset (deposit strategizer step size). */
export function tornadoMinDenomination(
  chainId: bigint,
  opts: { isEth: boolean; tokenAddress: string; symbol: string; excludeNewPools?: boolean }
): bigint {
  const pools = assertTornadoTokenSupported(chainId, opts);
  return pools.reduce(
    (m, p) => (p.denomination < m ? p.denomination : m),
    pools[0]!.denomination
  );
}

/**
 * Pool addresses the direct Tornado paymaster can sponsor (SDK allowlist).
 * ERC-20 unshields require the withdrawn asset to be quoteable as `feeToken`.
 */
export function tornadoPaymasterPoolAddresses(chainId: bigint): Set<string> {
  const cfg = TornadoPaymasterConfigs[Number(chainId) as keyof typeof TornadoPaymasterConfigs];
  if (!cfg?.supportedPools) return new Set();
  return new Set(
    cfg.supportedPools.map((a) => a.toLowerCase())
  );
}

/** Deposit catalog ∩ paymaster pool allowlist (unshieldable via paymaster). */
export function tornadoPaymasterPoolsForAsset(
  chainId: bigint,
  opts: { isEth: boolean; tokenAddress?: string; excludeNewPools?: boolean }
): TornadoSagaPool[] {
  const paymasterPools = tornadoPaymasterPoolAddresses(chainId);
  return tornadoPoolsForAsset(chainId, opts).filter((p) =>
    paymasterPools.has(p.poolAddress.toLowerCase())
  );
}

/**
 * Unshield via paymaster: token must have at least one allowlisted pool
 * so the paymaster can take fees in that asset (`quoteWeiInToken`).
 */
export function assertTornadoPaymasterTokenSupported(
  chainId: bigint,
  opts: { isEth: boolean; tokenAddress: string; symbol: string; excludeNewPools?: boolean }
): TornadoSagaPool[] {
  const depositPools = tornadoPoolsForAsset(chainId, opts);
  const paymasterPools = tornadoPaymasterPoolsForAsset(chainId, opts);
  if (paymasterPools.length > 0) return paymasterPools;

  if (depositPools.length > 0) {
    throw new Error(
      opts.isEth
        ? `Tornado Cash ETH pools exist on chainId ${chainId.toString()}, but none are configured for the Tornado paymaster.`
        : `Token ${opts.symbol} can be shielded into Tornado on chainId ${chainId.toString()}, but the paymaster has no supported pool for it (cannot take ${opts.symbol} as feeToken). Unshield via paymaster is unsupported for this asset.`
    );
  }
  return assertTornadoTokenSupported(chainId, opts);
}

/**
 * Amount must be a positive exact multiple of the smallest denomination for
 * this asset (same rule the deposit strategizer uses).
 */
export function assertTornadoDepositAmount(
  chainId: bigint,
  amount: bigint,
  opts: {
    isEth: boolean;
    tokenAddress: string;
    symbol: string;
    decimals: number;
    excludeNewPools?: boolean;
  }
): void {
  if (amount <= 0n) {
    throw new Error("Amount must be greater than zero.");
  }
  const min = tornadoMinDenomination(chainId, opts);
  if (amount % min !== 0n) {
    const minFmt = formatUnits(min, opts.decimals);
    throw new Error(
      `Tornado amount must be a positive exact multiple of ${minFmt} ${opts.symbol} (smallest pool denomination).`
    );
  }
}

/** Throws unless `amount` equals exactly one pool denomination for this asset. */
export function assertTornadoExactPoolDenomination(
  chainId: bigint,
  amount: bigint,
  opts: {
    isEth: boolean;
    tokenAddress: string;
    symbol: string;
    decimals: number;
    excludeNewPools?: boolean;
  }
): TornadoSagaPool {
  if (amount <= 0n) {
    throw new Error("Amount must be greater than zero.");
  }
  const pools = assertTornadoTokenSupported(chainId, opts);
  const match = pools.filter((p) => p.denomination === amount);
  if (match.length === 0) {
    const dens = pools
      .map((p) => formatUnits(p.denomination, opts.decimals))
      .join(", ");
    throw new Error(
      `Amount ${formatUnits(amount, opts.decimals)} ${opts.symbol} is not an exact Tornado pool denomination. ` +
        `Valid ${opts.symbol} denominations: ${dens}.`
    );
  }
  return match[0]!;
}

/** Validate amount granularity; selected pools are checked separately before proving. */
export function assertTornadoUnshieldAmountForToken(
  chainId: bigint,
  amount: bigint,
  opts: {
    isEth: boolean;
    tokenAddress: string;
    symbol: string;
    decimals: number;
    excludeNewPools?: boolean;
  }
): void {
  assertTornadoDepositAmount(chainId, amount, opts);
}
