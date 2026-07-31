/**
 * Static Tornado Cash pool catalog (tokens + denominations) per chain.
 *
 * Sourced from the FAT Solutions saga index (mainnet / Sepolia differ).
 * Keep in sync when new pools are added; do not fetch at runtime.
 *
 * Unshield via paymaster requires each pool in
 * `@kohaku-eth/tornado-cash` `TornadoPaymasterConfigs.poolsAccountsMap`
 * (FeeAdapter). This catalog only lists pools that are both depositable and
 * paymaster-backed.
 */
import { formatUnits, getAddress, type Address } from "viem";
import { TornadoPaymasterConfigs } from "@kohaku-eth/tornado-cash";

export type TornadoSagaPool = {
  poolAddress: Address;
  denomination: bigint;
  asset: string;
  decimals: number;
  isERC20: boolean;
  /** Present for ERC-20 pools; omitted for ETH. */
  assetAddress?: Address;
};

type TornadoPoolDef = {
  poolAddress: `0x${string}`;
  denomination: bigint;
  asset: string;
  decimals: number;
  /** Token contract; omit for native ETH pools. */
  assetAddress?: `0x${string}`;
};

/**
 * Mainnet pools from saga `tornado-cash-1-*` entries.
 * Note: saga sometimes sets `isERC20: false` even for token pools; we treat
 * any entry with `assetAddress` as ERC-20.
 */
const MAINNET_POOLS: readonly TornadoPoolDef[] = [
  // ETH
  {
    poolAddress: "0x12D66f87A04A9E220743712cE6d9bB1B5616B8Fc",
    denomination: 100000000000000000n, // 0.1
    asset: "ETH",
    decimals: 18,
  },
  {
    poolAddress: "0x47CE0C6eD5B0Ce3d3A51fdb1C52DC66a7c3C2936",
    denomination: 1000000000000000000n, // 1
    asset: "ETH",
    decimals: 18,
  },
  {
    poolAddress: "0x910Cbd523D972eb0a6f4CaE4618AD62622b39DbF",
    denomination: 10000000000000000000n, // 10
    asset: "ETH",
    decimals: 18,
  },
  {
    poolAddress: "0xA160cdAB225685dA1d56aa342Ad8841c3b53f291",
    denomination: 100000000000000000000n, // 100
    asset: "ETH",
    decimals: 18,
  },
  // DAI
  {
    poolAddress: "0xD4B88Df4D29F5CedD6857912842cff3b20C8Cfa3",
    denomination: 100000000000000000000n, // 100
    asset: "DAI",
    decimals: 18,
    assetAddress: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
  },
  {
    poolAddress: "0xFD8610d20aa15b7B2E3Be39B396a1bC3516c7144",
    denomination: 1000000000000000000000n, // 1_000
    asset: "DAI",
    decimals: 18,
    assetAddress: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
  },
  {
    poolAddress: "0x07687e702b410Fa43f4cB4Af7FA097918ffD2730",
    denomination: 10000000000000000000000n, // 10_000
    asset: "DAI",
    decimals: 18,
    assetAddress: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
  },
  {
    poolAddress: "0x23773E65ed146A459791799d01336DB287f25334",
    denomination: 100000000000000000000000n, // 100_000
    asset: "DAI",
    decimals: 18,
    assetAddress: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
  },
  // USDC (6 decimals)
  {
    poolAddress: "0xd96f2b1c14db8458374d9aca76e26c3d18364307",
    denomination: 100000000n, // 100
    asset: "USDC",
    decimals: 6,
    assetAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  },
  {
    poolAddress: "0x4736dCf1b7A3d580672CcE6E7c65Cd5cc9cFBa9D",
    denomination: 1000000000n, // 1_000
    asset: "USDC",
    decimals: 6,
    assetAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  },
  // USDT (6 decimals)
  {
    poolAddress: "0x169AD27A470D064DEDE56a2D3ff727986b15D52B",
    denomination: 100000000n, // 100
    asset: "USDT",
    decimals: 6,
    assetAddress: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
  },
  {
    poolAddress: "0x0836222F2B2B24A3F36f98668Ed8F0B38D1a872f",
    denomination: 1000000000n, // 1_000
    asset: "USDT",
    decimals: 6,
    assetAddress: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
  },
  // WBTC (8 decimals)
  {
    poolAddress: "0x178169B423a011fff22B9e3F3abeA13414dDD0F1",
    denomination: 10000000n, // 0.1
    asset: "WBTC",
    decimals: 8,
    assetAddress: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599",
  },
  {
    poolAddress: "0x610B717796ad172B316836AC95a2ffad065CeaB4",
    denomination: 100000000n, // 1
    asset: "WBTC",
    decimals: 8,
    assetAddress: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599",
  },
  {
    poolAddress: "0xbB93e510BbCD0B7beb5A853875f9eC60275CF498",
    denomination: 1000000000n, // 10
    asset: "WBTC",
    decimals: 8,
    assetAddress: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599",
  },
] as const;

/** Sepolia pools from saga `tornado-cash-11155111-*` (ETH + DAI only). */
const SEPOLIA_POOLS: readonly TornadoPoolDef[] = [
  {
    poolAddress: "0x8c4a04d872a6c1be37964A21Ba3A138525dFF50b",
    denomination: 100000000000000000n, // 0.1
    asset: "ETH",
    decimals: 18,
  },
  {
    poolAddress: "0x8cc930096b4df705a007c4a039bdfa1320ed2508",
    denomination: 1000000000000000000n, // 1
    asset: "ETH",
    decimals: 18,
  },
  {
    poolAddress: "0x6921fd1A97441dd603A997ed6DdF388658daF754",
    denomination: 100000000000000000000n, // 100
    asset: "DAI",
    decimals: 18,
    assetAddress: "0xFF34B3d4Aee8ddCd6F9AFFFB6Fe49bD371b8a357",
  },
] as const;

function toPool(def: TornadoPoolDef): TornadoSagaPool {
  const isERC20 = def.assetAddress != null;
  return {
    poolAddress: getAddress(def.poolAddress),
    denomination: def.denomination,
    asset: def.asset,
    decimals: def.decimals,
    isERC20,
    ...(isERC20 && def.assetAddress
      ? { assetAddress: getAddress(def.assetAddress) }
      : {}),
  };
}

/** All Tornado Cash pools for this chain (static catalog). */
export function tornadoPoolsForChain(chainId: bigint): TornadoSagaPool[] {
  if (chainId === 1n) return MAINNET_POOLS.map(toPool);
  if (chainId === 11155111n) return SEPOLIA_POOLS.map(toPool);
  return [];
}

export function tornadoPoolsForAsset(
  chainId: bigint,
  opts: { isEth: boolean; tokenAddress?: string }
): TornadoSagaPool[] {
  const pools = tornadoPoolsForChain(chainId);
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
  opts: { isEth: boolean; tokenAddress: string; symbol: string }
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

/**
 * Pool addresses the on-chain Tornado paymaster can sponsor (FeeAdapter map).
 * ERC-20 unshields require the withdrawn asset to be quoteable as `feeToken`.
 */
export function tornadoPaymasterPoolAddresses(chainId: bigint): Set<string> {
  const cfg =
    TornadoPaymasterConfigs[Number(chainId) as keyof typeof TornadoPaymasterConfigs];
  if (!cfg?.poolsAccountsMap) return new Set();
  return new Set(
    Object.keys(cfg.poolsAccountsMap).map((a) => a.toLowerCase())
  );
}

/** Deposit catalog ∩ paymaster FeeAdapter map (unshieldable via paymaster). */
export function tornadoPaymasterPoolsForAsset(
  chainId: bigint,
  opts: { isEth: boolean; tokenAddress?: string }
): TornadoSagaPool[] {
  const paymasterPools = tornadoPaymasterPoolAddresses(chainId);
  return tornadoPoolsForAsset(chainId, opts).filter((p) =>
    paymasterPools.has(p.poolAddress.toLowerCase())
  );
}

/**
 * Unshield via paymaster: token must have at least one pool with a FeeAdapter
 * so the paymaster can take fees in that asset (`quoteWeiInToken`).
 */
export function assertTornadoPaymasterTokenSupported(
  chainId: bigint,
  opts: { isEth: boolean; tokenAddress: string; symbol: string }
): TornadoSagaPool[] {
  const depositPools = tornadoPoolsForAsset(chainId, opts);
  const paymasterPools = tornadoPaymasterPoolsForAsset(chainId, opts);
  if (paymasterPools.length > 0) return paymasterPools;

  if (depositPools.length > 0) {
    throw new Error(
      opts.isEth
        ? `Tornado Cash ETH pools exist on chainId ${chainId.toString()}, but none have a paymaster FeeAdapter configured.`
        : `Token ${opts.symbol} can be shielded into Tornado on chainId ${chainId.toString()}, but the paymaster has no FeeAdapter for it (cannot take ${opts.symbol} as feeToken). Unshield via paymaster is unsupported for this asset.`
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
  }
): void {
  if (amount <= 0n) {
    throw new Error("Amount must be greater than zero.");
  }
  const pools = assertTornadoTokenSupported(chainId, opts);
  const min = pools.reduce(
    (m, p) => (p.denomination < m ? p.denomination : m),
    pools[0]!.denomination
  );
  if (amount % min !== 0n) {
    const minFmt = formatUnits(min, opts.decimals);
    throw new Error(
      `Tornado amount must be a positive exact multiple of ${minFmt} ${opts.symbol} (smallest pool denomination).`
    );
  }
}

/** Like {@link assertTornadoDepositAmount}, but only against paymaster-backed pools. */
export function assertTornadoUnshieldAmountForToken(
  chainId: bigint,
  amount: bigint,
  opts: {
    isEth: boolean;
    tokenAddress: string;
    symbol: string;
    decimals: number;
  }
): void {
  if (amount <= 0n) {
    throw new Error("Amount must be greater than zero.");
  }
  const pools = assertTornadoPaymasterTokenSupported(chainId, opts);
  const min = pools.reduce(
    (m, p) => (p.denomination < m ? p.denomination : m),
    pools[0]!.denomination
  );
  if (amount % min !== 0n) {
    const minFmt = formatUnits(min, opts.decimals);
    throw new Error(
      `Tornado unshield amount must be a positive exact multiple of ${minFmt} ${opts.symbol} (smallest paymaster-backed pool denomination).`
    );
  }
}
