import { Contract, getAddress, isAddress } from "ethers";

import { ETH_AS_ERC20 } from "./plugins";
import { makeEthersProvider } from "./rpc";

// --- Default ERC-20 lists per chain (balances) ---

/** ERC20 with fixed metadata (no RPC reads for symbol/decimals). */
export type KnownErc20 = {
  address: `0x${string}`;
  symbol: string;
  decimals: number;
};

/**
 * Default ERC20s to include in `balances` per chain (in addition to `--tokensList`).
 * Addresses are checksummed at load time.
 */
function checksummed(addr: string): `0x${string}` {
  return getAddress(addr) as `0x${string}`;
}

export const DEFAULT_ERC20_BY_CHAIN_ID: Record<string, KnownErc20[]> = {
  "1": [
    { address: checksummed("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"), symbol: "USDC", decimals: 6 },
    { address: checksummed("0xdAC17F958D2ee523a2206206994597C13D831ec7"), symbol: "USDT", decimals: 6 },
    { address: checksummed("0x6B175474E89094C44Da98b954EedeAC495271d0F"), symbol: "DAI", decimals: 18 },
    { address: checksummed("0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"), symbol: "WETH", decimals: 18 },
  ],
  "11155111": [
    { address: checksummed("0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238"), symbol: "USDC", decimals: 6 },
    { address: checksummed("0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14"), symbol: "WETH", decimals: 18 },
  ],
};

export type MergedPublicTokenList = {
  /** ERC20 contract addresses: defaults for the chain first, then extra from CLI (deduped). */
  erc20Addresses: `0x${string}`[];
  /** Lowercase address → metadata when known without RPC. */
  knownMetaByLower: Map<string, { symbol: string; decimals: number }>;
};

/**
 * Merges chain default tokens with `--tokensList` extras. CLI addresses that duplicate
 * a default are skipped; unknown addresses are appended for RPC metadata + balanceOf.
 */
export function mergeDefaultAndExtraErc20s(
  chainId: string,
  extraFromCli: `0x${string}`[]
): MergedPublicTokenList {
  const defaults = DEFAULT_ERC20_BY_CHAIN_ID[chainId] ?? [];
  const knownMetaByLower = new Map<
    string,
    { symbol: string; decimals: number }
  >();
  const seen = new Set<string>();
  const erc20Addresses: `0x${string}`[] = [];

  for (const t of defaults) {
    const lower = t.address.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    knownMetaByLower.set(lower, {
      symbol: t.symbol,
      decimals: t.decimals,
    });
    erc20Addresses.push(t.address);
  }

  for (const addr of extraFromCli) {
    const lower = addr.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    erc20Addresses.push(addr);
  }

  return { erc20Addresses, knownMetaByLower };
}

// --- ERC-20 ABI (balances, shield, token metadata) ---

/** Shared ERC-20 fragment: balances, approve/allowance (shield), symbol/decimals (metadata). */
export const ERC20_ABI = [
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
] as const;

export type ResolvedTokenMeta = {
  symbol: string;
  tokenAddress: string;
  decimals: number;
  isEth: boolean;
};

export async function resolveTokenMeta(
  tokenArg: string | undefined,
  rpcUrl: string
): Promise<ResolvedTokenMeta> {
  if (!tokenArg || tokenArg.toLowerCase() === "eth") {
    return { symbol: "ETH", tokenAddress: ETH_AS_ERC20, decimals: 18, isEth: true };
  }
  if (!isAddress(tokenArg)) {
    throw new Error(`Invalid token address: ${tokenArg}`);
  }
  const tokenAddress = getAddress(tokenArg);
  const rpc = await makeEthersProvider(rpcUrl);
  try {
    const erc20 = new Contract(tokenAddress, ERC20_ABI, rpc);
    let decimals: number;
    try {
      decimals = Number(await erc20.decimals());
    } catch {
      throw new Error(`Failed to read decimals() from token ${tokenAddress}`);
    }
    const symbol = await erc20.symbol().catch(() => "UNKNOWN");
    return { symbol, tokenAddress, decimals, isEth: false };
  } finally {
    rpc.destroy();
  }
}
