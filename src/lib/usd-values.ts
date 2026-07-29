import {
  chainlinkQuoter,
  createAutoRouter,
  createNetworkContext,
  createRouter,
  fixedQuoter,
  uniswapV2Discoverer,
  uniswapV2Quoter,
  uniswapV3Discoverer,
  type Router,
} from "eth-prices";
import { getAddress, isAddress } from "viem";
import { from as providerFrom } from "ox/Provider";
import { fromHttp } from "ox/RpcTransport";

import type { BalanceItem } from "./balances-snapshot.js";
import { wethAddressForChain } from "../utils/tokens-util.js";

/** Sentinel when prices are unavailable (testnet) or a quote fails. */
export const USD_VALUE_UNAVAILABLE = "--";

const MAINNET = 1;
const USD = "fiat:usd";
const USD_DECIMALS = 6;

const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" as const;
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as const;
const USDT = "0xdAC17F958D2ee523a2206206994597C13D831ec7" as const;
const DAI = "0x6B175474E89094C44Da98b954EedeAC495271d0F" as const;
const USDS = "0xdC035D45d973E3EC169d2276DDab16f1e407384F" as const;
const PYUSD = "0x6c3ea9036406852006290770BEdFcAbA0e23A0e8" as const;
const FRAX = "0x853d955aCEf822Db058eb8505911ED77F175b99e" as const;
const USDe = "0x4c9edd5852cd905f086c759e8383e09bff1e68b3" as const;

const CHAINLINK_ETH_USD = "0x5f4ec3df9cbd43714fe2740f5e3616155c5b8419" as const;
const UNISWAP_V2_USDC_WETH_PAIR =
  "0xB4e16d0168e52d35CaCD2c6185b44281Ec28C9Dc" as const;
const UNISWAP_V2_FACTORY = "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f" as const;
const UNISWAP_V3_FACTORY = "0x1F98431c8aD98523631AE4a59f267346ea31F984" as const;

function isMainnet(chainId: bigint | string): boolean {
  return chainId.toString() === String(MAINNET);
}

/** Round USD (6 decimals) half-up to cents → `"12.34"`. */
export function formatUsdCents(amountUsd6: bigint): string {
  const roundedCents = (amountUsd6 + 5_000n) / 10_000n;
  const negative = roundedCents < 0n;
  const abs = negative ? -roundedCents : roundedCents;
  const whole = abs / 100n;
  const frac = abs % 100n;
  return `${negative ? "-" : ""}${whole}.${frac.toString().padStart(2, "0")}`;
}

function pricingAssetForRow(
  row: BalanceItem,
  chainId: bigint
): `0x${string}` | null {
  if (row.token_address === "---" || row.symbol.replace(/ \(pending\)$/, "") === "ETH") {
    return (wethAddressForChain(chainId) ?? WETH) as `0x${string}`;
  }
  if (!isAddress(row.token_address)) return null;
  return getAddress(row.token_address) as `0x${string}`;
}

function stableFixedQuoter(
  token: `0x${string}`,
  tokenDecimals: number
) {
  return fixedQuoter({
    inputAsset: token,
    inputAssetDecimals: tokenDecimals,
    outputAsset: USD,
    outputAssetDecimals: USD_DECIMALS,
    fixedRate: 10n ** BigInt(USD_DECIMALS),
    fixedRateDecimals: USD_DECIMALS,
  });
}

function baseMainnetQuoters() {
  return [
    chainlinkQuoter({
      networkId: MAINNET,
      feedAddress: CHAINLINK_ETH_USD,
      token: WETH,
      quote: USD,
      feedDecimals: 8,
      tokenDecimals: 18,
      quoteDecimals: USD_DECIMALS,
    }),
    uniswapV2Quoter({
      networkId: MAINNET,
      pairAddress: UNISWAP_V2_USDC_WETH_PAIR,
      token0: USDC,
      token1: WETH,
    }),
    stableFixedQuoter(USDC, 6),
    stableFixedQuoter(USDT, 6),
    stableFixedQuoter(DAI, 18),
    stableFixedQuoter(USDS, 18),
    stableFixedQuoter(PYUSD, 6),
    stableFixedQuoter(FRAX, 18),
    stableFixedQuoter(USDe, 18),
  ];
}

const STABLE_ADDRESSES = new Set(
  [USDC, USDT, DAI, USDS, PYUSD, FRAX, USDe].map((a) => a.toLowerCase())
);

function needsPoolDiscovery(tokens: readonly `0x${string}`[]): boolean {
  return tokens.some((t) => {
    const key = t.toLowerCase();
    return key !== WETH.toLowerCase() && !STABLE_ADDRESSES.has(key);
  });
}

async function buildMainnetRouter(
  rpcUrl: string,
  tokens: readonly `0x${string}`[]
): Promise<{ router: Router; context: ReturnType<typeof createNetworkContext> }> {
  const provider = providerFrom(fromHttp(rpcUrl));
  const context = createNetworkContext({ [MAINNET]: provider });

  if (!needsPoolDiscovery(tokens)) {
    const router = createRouter(baseMainnetQuoters());
    return { router, context };
  }

  const hubTokens = new Set<string>([
    WETH.toLowerCase(),
    USDC.toLowerCase(),
  ]);
  const discoveryTokens: `0x${string}`[] = [WETH, USDC];
  for (const t of tokens) {
    const key = t.toLowerCase();
    if (hubTokens.has(key)) continue;
    hubTokens.add(key);
    discoveryTokens.push(t);
  }

  const { router } = await createAutoRouter({
    tokens: discoveryTokens,
    context,
    discoverers: [
      uniswapV3Discoverer({
        networkId: MAINNET,
        factoryAddress: UNISWAP_V3_FACTORY,
      }),
      uniswapV2Discoverer({
        networkId: MAINNET,
        factoryAddress: UNISWAP_V2_FACTORY,
      }),
    ],
  });
  router.addQuoters(baseMainnetQuoters());
  return { router, context };
}

/**
 * Quote unit price (1 whole token) once per unique asset.
 */
async function fetchUnitPricesUsd6(
  rpcUrl: string,
  assets: readonly { address: `0x${string}`; decimals: number }[]
): Promise<Map<string, bigint>> {
  const unique = new Map<string, { address: `0x${string}`; decimals: number }>();
  for (const a of assets) {
    unique.set(a.address.toLowerCase(), a);
  }
  if (unique.size === 0) return new Map();

  const { router, context } = await buildMainnetRouter(
    rpcUrl,
    [...unique.values()].map((a) => a.address)
  );

  const prices = new Map<string, bigint>();
  await Promise.all(
    [...unique.entries()].map(async ([key, { address, decimals }]) => {
      try {
        const oneUnit = 10n ** BigInt(decimals);
        const usd6 = await router.quote(address, USD, {
          amountIn: oneUnit,
          context,
        });
        prices.set(key, usd6);
      } catch {
        // Leave missing → caller writes "--"
      }
    })
  );
  return prices;
}

function usdValueForAmount(
  unitPriceUsd6: bigint | undefined,
  rawHoldings: string,
  decimals: number
): string {
  if (unitPriceUsd6 === undefined) return USD_VALUE_UNAVAILABLE;
  let raw: bigint;
  try {
    raw = BigInt(rawHoldings);
  } catch {
    return USD_VALUE_UNAVAILABLE;
  }
  const scale = 10n ** BigInt(decimals);
  const usd6 = (unitPriceUsd6 * raw) / scale;
  return formatUsdCents(usd6);
}

function markUnavailable(rows: BalanceItem[]): BalanceItem[] {
  return rows.map((r) => ({ ...r, usd_value: USD_VALUE_UNAVAILABLE }));
}

/**
 * Attach `usd_value` to each balance row.
 * Testnet / non-mainnet: `"--"` with no RPC price fetches.
 * Mainnet: token unit price × holdings, rounded to the cent.
 */
export async function attachUsdValues(
  rows: BalanceItem[],
  opts: { chainId: bigint; rpcUrl: string }
): Promise<BalanceItem[]> {
  if (rows.length === 0) return rows;
  if (!isMainnet(opts.chainId)) {
    return markUnavailable(rows);
  }

  const assets: { address: `0x${string}`; decimals: number }[] = [];
  const pricingKeyByIndex: (string | null)[] = [];
  for (const row of rows) {
    const asset = pricingAssetForRow(row, opts.chainId);
    if (!asset) {
      pricingKeyByIndex.push(null);
      continue;
    }
    pricingKeyByIndex.push(asset.toLowerCase());
    assets.push({ address: asset, decimals: row.decimals });
  }

  let unitPrices: Map<string, bigint>;
  try {
    unitPrices = await fetchUnitPricesUsd6(opts.rpcUrl, assets);
  } catch {
    return markUnavailable(rows);
  }

  return rows.map((row, i) => {
    const key = pricingKeyByIndex[i];
    const usd_value =
      key == null
        ? USD_VALUE_UNAVAILABLE
        : usdValueForAmount(unitPrices.get(key), row.raw_token_holdings, row.decimals);
    return { ...row, usd_value };
  });
}

export async function attachUsdValuesToRowsLists(
  lists: BalanceItem[][],
  opts: { chainId: bigint; rpcUrl: string }
): Promise<BalanceItem[][]> {
  const flat = lists.flat();
  const enriched = await attachUsdValues(flat, opts);
  let offset = 0;
  return lists.map((list) => {
    const slice = enriched.slice(offset, offset + list.length);
    offset += list.length;
    return slice;
  });
}
