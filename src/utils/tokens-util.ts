import { getAddress, isAddress, parseAbi } from "viem";

import { ETH_AS_ERC20 } from "./plugins";
import { makePublicClient } from "./rpc";

/** Native ETH in private balance rows (privacy-pools: EEE…; zero address variants). */
export function isPrivateBalanceNativeEth(addrStr: string): boolean {
  const lower = addrStr.toLowerCase();
  if (lower === ETH_AS_ERC20.toLowerCase()) return true;
  if (!lower.startsWith("0x")) return false;
  const body = lower.slice(2);
  return body.length > 0 && /^0+$/.test(body);
}

/** Human-readable status for a private `balance()` row tag (Railgun POI or PP pending). */
export function privateBalanceStatusLabel(tag: string): string {
  switch (tag) {
    case "pending":
    case "Missing":
      return "pending";
    case "Valid":
      return "spendable";
    case "ProofSubmitted":
      return "proof submitted";
    case "ShieldBlocked":
      return "blocked";
    default:
      return tag;
  }
}

/** True when a private `balance()` row is spendable for unshield / transfer. */
export function isSpendablePrivateBalanceTag(tag?: string): boolean {
  return !tag || tag === "Valid";
}

/** True when a private `balance()` row is not yet spendable (POI / approval pending). */
export function isPendingPrivateBalanceRow(row: { tag?: string }): boolean {
  return row.tag !== undefined && !isSpendablePrivateBalanceTag(row.tag);
}

/** Match a private `balance()` row asset to the token being unshielded. */
export function privateBalanceRowMatchesUnshieldToken(
  rowAssetAddr: string,
  tokenMeta: { isEth: boolean; tokenAddress: string },
  chainId: bigint,
  protocol: "railgun" | "tornado" = "railgun"
): boolean {
  const addr = rowAssetAddr.toLowerCase();
  if (tokenMeta.isEth) {
    if (protocol === "tornado") {
      return isPrivateBalanceNativeEth(addr);
    }
    const weth = wethAddressForChain(chainId);
    return weth ? addr === weth.toLowerCase() : false;
  }
  return addr === tokenMeta.tokenAddress.toLowerCase();
}

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
  const normalized = addr.startsWith("0x") ? addr : `0x${addr}`;
  return getAddress(normalized.toLowerCase()) as `0x${string}`;
}

function knownToken(
  symbol: string,
  address: string,
  decimals: number
): KnownErc20 {
  return { symbol, address: checksummed(address), decimals };
}

/** Canonical mainnet ERC-20s resolvable by `--token <symbol>`. */
const MAINNET_KNOWN_TOKENS: KnownErc20[] = [
  knownToken("USDC", "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", 6),
  knownToken("USDT", "0xdAC17F958D2ee523a2206206994597C13D831ec7", 6),
  knownToken("DAI", "0x6B175474E89094C44Da98b954EedeAC495271d0F", 18),
  knownToken("WETH", "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", 18),
  knownToken("WBTC", "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599", 8),
  knownToken("USDS", "0xdC035D45d973E3EC169d2276DDab16f1e407384F", 18),
  knownToken("UNI", "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984", 18),
  knownToken("LINK", "0x514910771AF9Ca656af840dff83E8264EcF986CA", 18),
  knownToken("AAVE", "0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9", 18),
  knownToken("MKR", "0x9f8F72aA9304c8B593d555F12eF6589cC3A579A2", 18),
  knownToken("LDO", "0x5A98FcBEA516Cf06857215779Fd812CA3beF1B32", 18),
  knownToken("CRV", "0xD533a949740bb3306d119CC777fa900bA034cd52", 18),
  knownToken("SNX", "0xC011a73ee8576Fb46F5E1c5751cA3B9Fe0af2a6F", 18),
  knownToken("COMP", "0xc00e94Cb662C3520282E6f5717214004A7f26888", 18),
  knownToken("SHIB", "0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE", 18),
  knownToken("PEPE", "0x6982508145454Ce325dDbE47a25d4ec3d2311933", 18),
  knownToken("stETH", "0xae7ab96520de3a18e5d111722f8daa6aef8b9c1c", 18),
  knownToken("wstETH", "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0", 18),
  knownToken("rETH", "0xae78736Cd615f374D3085123A210448E74Fc6393", 18),
  knownToken("cbETH", "0xBe9895146f7AF43049ca1c1AE358B0541Ea49704", 18),
  knownToken("FRAX", "0x853d955aCEf822Db058eb8505911ED77F175b99e", 18),
  knownToken("USDe", "0x4c9edd5852cd905f086c759e8383e09bff1e68b3", 18),
  knownToken("ENA", "0x57e114B691Db790C35207b2e685D4A43181e6061", 18),
  knownToken("GRT", "0xc944E90C64B2c07662A292be6244BDf05Cda44a7", 18),
  knownToken("POL", "0x455e53CBB86018Ac2B8092FdCd39d8444aFFC3F6", 18),
  knownToken("PYUSD", "0x6c3ea9036406852006290770BEdFcAbA0e23A0e8", 6),
];

/** Sepolia ERC-20s resolvable by `--token <symbol>`. */
const SEPOLIA_KNOWN_TOKENS: KnownErc20[] = [
  knownToken("USDC", "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238", 6),
  knownToken("DAI", "0xFF34B3d4Aee8ddCd6F9AFFFB6Fe49bD371b8a357", 18),
  knownToken("WETH", "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14", 18),
];

function buildSymbolLookup(
  tokens: KnownErc20[]
): Map<string, KnownErc20> {
  const map = new Map<string, KnownErc20>();
  for (const token of tokens) {
    map.set(token.symbol.toUpperCase(), token);
  }
  return map;
}

const TOKEN_SYMBOL_BY_CHAIN_ID: Record<string, Map<string, KnownErc20>> = {
  "1": buildSymbolLookup(MAINNET_KNOWN_TOKENS),
  "11155111": buildSymbolLookup(SEPOLIA_KNOWN_TOKENS),
};

/** Lookup a known token by symbol on mainnet or Sepolia. */
export function lookupKnownTokenBySymbol(
  chainId: string | bigint,
  symbol: string
): KnownErc20 | undefined {
  const id = typeof chainId === "bigint" ? chainId.toString() : chainId;
  return TOKEN_SYMBOL_BY_CHAIN_ID[id]?.get(symbol.toUpperCase());
}

/** Sorted symbols available for `--token` on this chain (empty when unsupported). */
export function knownTokenSymbolsForChain(chainId: string | bigint): string[] {
  const id = typeof chainId === "bigint" ? chainId.toString() : chainId;
  const map = TOKEN_SYMBOL_BY_CHAIN_ID[id];
  if (!map) return [];
  return [...map.keys()].sort();
}

export const DEFAULT_ERC20_BY_CHAIN_ID: Record<string, KnownErc20[]> = {
  "1": MAINNET_KNOWN_TOKENS.filter((t) =>
    ["USDC", "USDT", "DAI", "WETH"].includes(t.symbol)
  ),
  "11155111": SEPOLIA_KNOWN_TOKENS,
};

export type MergedPublicTokenList = {
  /** ERC20 contract addresses: defaults for the chain first, then extra from CLI (deduped). */
  erc20Addresses: `0x${string}`[];
  /** Lowercase address → metadata when known without RPC. */
  knownMetaByLower: Map<string, { symbol: string; decimals: number }>;
};

/** Canonical WETH for a chain (Railgun shields ETH as this ERC-20). */
export function wethAddressForChain(
  chainId: string | bigint
): `0x${string}` | undefined {
  const id = typeof chainId === "bigint" ? chainId.toString() : chainId;
  return (DEFAULT_ERC20_BY_CHAIN_ID[id] ?? []).find((t) => t.symbol === "WETH")
    ?.address;
}

/**
 * Merges chain default tokens with `--tokensList` extras (and private ERC-20s).
 * Addresses that already appear in the default list are skipped; unknown
 * addresses are appended for RPC metadata + balanceOf. Comparison is
 * case-insensitive, so the merged list is a set of unique contracts.
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
export const ERC20_ABI = parseAbi([
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function transfer(address to, uint256 amount) returns (bool)",
]);

export type ResolvedTokenMeta = {
  symbol: string;
  tokenAddress: string;
  decimals: number;
  isEth: boolean;
};

export async function resolveTokenMeta(
  tokenArg: string | undefined,
  rpcUrl: string,
  chainId: bigint
): Promise<ResolvedTokenMeta> {
  if (!tokenArg || tokenArg.toLowerCase() === "eth") {
    return { symbol: "ETH", tokenAddress: ETH_AS_ERC20, decimals: 18, isEth: true };
  }
  if (isAddress(tokenArg)) {
    const tokenAddress = getAddress(tokenArg);
    const client = await makePublicClient(rpcUrl);
    let decimals: number;
    try {
      decimals = Number(
        await client.readContract({
          address: tokenAddress,
          abi: ERC20_ABI,
          functionName: "decimals",
        })
      );
    } catch {
      throw new Error(`Failed to read decimals() from token ${tokenAddress}`);
    }
    const symbol = await client.readContract({
      address: tokenAddress,
      abi: ERC20_ABI,
      functionName: "symbol",
    }).catch(() => "UNKNOWN");
    return { symbol, tokenAddress, decimals, isEth: false };
  }

  const known = lookupKnownTokenBySymbol(chainId, tokenArg);
  if (known) {
    return {
      symbol: known.symbol,
      tokenAddress: known.address,
      decimals: known.decimals,
      isEth: false,
    };
  }

  const knownSymbols = knownTokenSymbolsForChain(chainId);
  if (knownSymbols.length > 0) {
    throw new Error(
      `Unknown token symbol "${tokenArg}". Pass a contract address with --token, or use one of: ${knownSymbols.join(", ")}`
    );
  }
  throw new Error(
    `Unknown token "${tokenArg}". Pass a contract address with --token (symbol shortcuts are only supported on mainnet and Sepolia).`
  );
}
