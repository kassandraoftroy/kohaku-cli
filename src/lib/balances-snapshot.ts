import type { AssetAmount } from "@kohaku-eth/plugins";
import { Contract, formatUnits, getAddress, isAddress } from "ethers";

import { makeHost } from "../host/makeHost";
import { makeEthersProvider } from "../utils/rpc";
import { withProtocolRuntime } from "./protocol-runtime";
import { ERC20_ABI, mergeDefaultAndExtraErc20s } from "../utils/tokens-util";
import {
  createProtocolPlugin,
  ETH_AS_ERC20,
  pluginIdForProtocol,
  type SupportedProtocol,
} from "../utils/plugins";
import { makePublicAccountsStorage } from "../utils/public-accounts";

export type BalanceItem = {
  symbol: string;
  token_address: string;
  decimals: number;
  raw_token_holdings: string;
  formatted_token_holdings: string;
};

export type PrivateNoteRow = {
  label: string;
  balance_raw: string;
  balance_formatted: string;
  asset_address: string;
  approved: boolean;
  precommitment: string;
};

export type BalancesSnapshot = {
  chainId: string;
  publicAggregated: BalanceItem[];
  publicByAddress: Record<string, BalanceItem[]>;
  publicAccountIndexByAddress: Record<string, number>;
  privateRailgun: BalanceItem[];
  privatePrivacyPools: BalanceItem[];
  privacyPoolsNotes?: PrivateNoteRow[];
};

function isNonZeroRawHoldings(raw: string): boolean {
  try {
    return BigInt(raw) !== 0n;
  } catch {
    return true;
  }
}

function filterNonZeroBalanceItems(rows: BalanceItem[]): BalanceItem[] {
  return rows.filter((r) => isNonZeroRawHoldings(r.raw_token_holdings));
}

function filterPublicByAddress(
  byAddress: Record<string, BalanceItem[]>
): Record<string, BalanceItem[]> {
  const out: Record<string, BalanceItem[]> = {};
  for (const [addr, rows] of Object.entries(byAddress)) {
    const filtered = filterNonZeroBalanceItems(rows);
    if (filtered.length > 0) {
      out[addr] = filtered;
    }
  }
  return out;
}

function filterNonZeroNotes(notes: PrivateNoteRow[]): PrivateNoteRow[] {
  return notes.filter((n) => isNonZeroRawHoldings(n.balance_raw));
}

function collectErc20AddressesFromPrivateBalances(
  rows: AssetAmount[]
): `0x${string}`[] {
  const seen = new Set<string>();
  const out: `0x${string}`[] = [];
  for (const row of rows) {
    const asset = row.asset as { __type?: string; contract?: unknown } | undefined;
    if (!asset || asset.__type !== "erc20") continue;
    const raw = asset.contract;
    let addrStr: string | null = null;
    if (typeof raw === "string" && isAddress(raw)) {
      addrStr = raw;
    } else if (typeof raw === "bigint") {
      addrStr = `0x${raw.toString(16).padStart(40, "0")}`;
    }
    if (!addrStr || !isAddress(addrStr)) continue;
    const checksum = getAddress(addrStr) as `0x${string}`;
    if (checksum.toLowerCase() === ETH_AS_ERC20.toLowerCase()) continue;
    const k = checksum.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(checksum);
  }
  return out;
}

function mapPrivateBalanceRows(
  rows: AssetAmount[],
  tokenMeta: Map<string, { symbol: string; decimals: number }>
): BalanceItem[] {
  return rows.map((row) => {
    const asset = row.asset as { __type?: string; contract?: unknown } | undefined;
    const amount = row.amount;
    const tag = "tag" in row ? (row as { tag?: string }).tag : undefined;

    if (!asset || asset.__type !== "erc20") {
      return {
        symbol: "UNKNOWN",
        token_address: "---",
        decimals: 18,
        raw_token_holdings: amount.toString(),
        formatted_token_holdings: formatUnits(amount, 18),
      };
    }
    const raw = asset.contract;
    let addrStr: string;
    if (typeof raw === "string") addrStr = raw;
    else if (typeof raw === "bigint") {
      addrStr = `0x${raw.toString(16).padStart(40, "0")}`;
    } else {
      addrStr = "---";
    }
    const isEth = addrStr.toLowerCase() === ETH_AS_ERC20.toLowerCase();
    const key =
      isEth || !isAddress(addrStr)
        ? null
        : (getAddress(addrStr).toLowerCase() as string);
    const meta = key ? tokenMeta.get(key) : { symbol: "ETH", decimals: 18 };
    const decimals = meta?.decimals ?? 18;
    let symbol = meta?.symbol ?? "UNKNOWN";
    if (tag === "pending") {
      symbol = `${symbol} (pending)`;
    }
    const tokenAddr =
      isEth || !isAddress(addrStr) ? "---" : getAddress(addrStr);
    return {
      symbol,
      token_address: tokenAddr,
      decimals,
      raw_token_holdings: amount.toString(),
      formatted_token_holdings: formatUnits(amount, decimals),
    };
  });
}

async function loadPrivateBalancesForProtocol(
  protocol: SupportedProtocol,
  rpcUrl: string,
  walletDir: string,
  password: string,
  mnemonic: string,
  chainId: bigint
): Promise<AssetAmount[]> {
  return withProtocolRuntime(
    { protocol, rpcUrl, walletDir, password, mnemonic, chainId },
    async (_host, plugin) => plugin.balance(undefined)
  );
}

type PpNotesPlugin = {
  notes: (
    assets?: unknown,
    includeSpent?: boolean
  ) => Promise<
    Array<{
      label: bigint;
      balance: bigint;
      assetAddress: bigint | string;
      approved: boolean;
      precommitment: bigint;
    }>
  >;
};

async function loadPrivacyPoolsNotes(
  rpcUrl: string,
  walletDir: string,
  password: string,
  mnemonic: string,
  chainId: bigint,
  tokenMeta: Map<string, { symbol: string; decimals: number }>
): Promise<PrivateNoteRow[]> {
  const rpc = await makeEthersProvider(rpcUrl);
  try {
    const host = await makeHost({
      rpc,
      walletDir,
      password,
      mnemonic,
      pluginId: pluginIdForProtocol("privacy-pools"),
    });
    const plugin = (await createProtocolPlugin(
      "privacy-pools",
      host,
      chainId
    )) as unknown as PpNotesPlugin;
    const notes = await plugin.notes(undefined, false);
    return notes.map((n) => {
      const rawAddr = n.assetAddress;
      const assetHex =
        typeof rawAddr === "bigint"
          ? `0x${rawAddr.toString(16).padStart(40, "0")}`
          : String(rawAddr);
      const addrStr = isAddress(assetHex) ? getAddress(assetHex) : assetHex;
      const canonicalKey = isAddress(addrStr)
        ? getAddress(addrStr).toLowerCase()
        : String(addrStr).toLowerCase();
      const meta = tokenMeta.get(canonicalKey) ?? {
        symbol: "UNKNOWN",
        decimals: 18,
      };
      return {
        label: n.label.toString(),
        balance_raw: n.balance.toString(),
        balance_formatted: formatUnits(n.balance, meta.decimals),
        asset_address: isAddress(addrStr) ? getAddress(addrStr) : addrStr,
        approved: n.approved,
        precommitment: n.precommitment.toString(),
      };
    });
  } finally {
    rpc.destroy();
  }
}

async function loadErc20Meta(
  provider: Awaited<ReturnType<typeof makeEthersProvider>>,
  token: `0x${string}`
): Promise<{ symbol: string; decimals: number }> {
  const c = new Contract(token, ERC20_ABI, provider);
  let decimals: number;
  try {
    decimals = Number(await c.decimals());
  } catch {
    throw new Error(`Failed to read decimals() for token ${token}`);
  }
  const symbol = await c.symbol().catch(() => "UNKNOWN");
  return { symbol, decimals };
}

export type LoadBalancesSnapshotOptions = {
  rpcUrl: string;
  walletDir: string;
  password: string;
  mnemonic: string;
  chainId: bigint;
  extraTokenAddresses?: `0x${string}`[];
  verbose?: boolean;
  onWarning?: (message: string) => void;
};

export async function loadBalancesSnapshot(
  opts: LoadBalancesSnapshotOptions
): Promise<BalancesSnapshot> {
  const {
    rpcUrl,
    walletDir,
    password,
    mnemonic,
    chainId,
    extraTokenAddresses = [],
    verbose = false,
    onWarning,
  } = opts;
  const chainIdString = chainId.toString();

  let rgRows: AssetAmount[] = [];
  let ppRows: AssetAmount[] = [];
  try {
    rgRows = await loadPrivateBalancesForProtocol(
      "railgun",
      rpcUrl,
      walletDir,
      password,
      mnemonic,
      chainId
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    onWarning?.(`Railgun private balances unavailable: ${msg}`);
  }
  try {
    ppRows = await loadPrivateBalancesForProtocol(
      "privacy-pools",
      rpcUrl,
      walletDir,
      password,
      mnemonic,
      chainId
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    onWarning?.(`Privacy pools private balances unavailable: ${msg}`);
  }

  const erc20FromPrivate = [
    ...collectErc20AddressesFromPrivateBalances(rgRows),
    ...collectErc20AddressesFromPrivateBalances(ppRows),
  ];

  const { erc20Addresses: tokenAddresses, knownMetaByLower } =
    mergeDefaultAndExtraErc20s(chainIdString, [
      ...extraTokenAddresses,
      ...erc20FromPrivate,
    ]);

  const publicStorage = makePublicAccountsStorage(walletDir, mnemonic, password);
  const publicAccounts = publicStorage.getAccounts();
  const publicAccountIndexByAddress: Record<string, number> = {};
  for (const acct of publicAccounts) {
    publicAccountIndexByAddress[acct.address] = acct.index;
  }

  const publicByAddress: Record<string, BalanceItem[]> = {};
  const aggregatedEth: bigint[] = [];
  const aggregatedByToken = new Map<string, bigint>();
  for (const t of tokenAddresses) {
    aggregatedByToken.set(t.toLowerCase(), 0n);
  }

  const rpcForPublic = await makeEthersProvider(rpcUrl);
  const tokenMeta = new Map<string, { symbol: string; decimals: number }>();
  let privateRailgun: BalanceItem[] = [];
  let privatePrivacyPools: BalanceItem[] = [];
  let privacyPoolsNotes: PrivateNoteRow[] | undefined;
  try {
    for (const token of tokenAddresses) {
      const key = token.toLowerCase();
      const known = knownMetaByLower.get(key);
      if (known) {
        tokenMeta.set(key, known);
      } else {
        tokenMeta.set(key, await loadErc20Meta(rpcForPublic, token));
      }
    }

    privateRailgun = mapPrivateBalanceRows(rgRows, tokenMeta);
    privatePrivacyPools = mapPrivateBalanceRows(ppRows, tokenMeta);

    if (verbose) {
      try {
        privacyPoolsNotes = await loadPrivacyPoolsNotes(
          rpcUrl,
          walletDir,
          password,
          mnemonic,
          chainId,
          tokenMeta
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        onWarning?.(`Privacy pools notes unavailable: ${msg}`);
        privacyPoolsNotes = [];
      }
    }

    const now = Date.now();
    const updatedAccounts: typeof publicAccounts = [];

    for (const acct of publicAccounts) {
      const ethBalance = await rpcForPublic.getBalance(acct.address);
      aggregatedEth.push(ethBalance);

      const erc20Balances = { ...acct.erc20Balances };
      const rows: BalanceItem[] = [
        {
          symbol: "ETH",
          token_address: "---",
          decimals: 18,
          raw_token_holdings: ethBalance.toString(),
          formatted_token_holdings: formatUnits(ethBalance, 18),
        },
      ];

      for (const token of tokenAddresses) {
        const key = token.toLowerCase();
        const c = new Contract(token, ERC20_ABI, rpcForPublic);
        const bal: bigint = await c.balanceOf(acct.address);
        erc20Balances[key] = bal.toString();
        aggregatedByToken.set(key, (aggregatedByToken.get(key) ?? 0n) + bal);
        const meta = tokenMeta.get(key)!;
        rows.push({
          symbol: meta.symbol,
          token_address: token,
          decimals: meta.decimals,
          raw_token_holdings: bal.toString(),
          formatted_token_holdings: formatUnits(bal, meta.decimals),
        });
      }

      updatedAccounts.push({
        ...acct,
        ethBalance: ethBalance.toString(),
        erc20Balances,
        lastUpdated: now,
      });

      publicByAddress[acct.address] = rows;
    }

    if (updatedAccounts.length > 0) {
      publicStorage.setAccounts(updatedAccounts);
    }
  } finally {
    rpcForPublic.destroy();
  }

  const totalPublicEth = aggregatedEth.reduce((a, b) => a + b, 0n);

  const publicBalancesAggregated: BalanceItem[] = [
    {
      symbol: "ETH",
      token_address: "---",
      decimals: 18,
      raw_token_holdings: totalPublicEth.toString(),
      formatted_token_holdings: formatUnits(totalPublicEth, 18),
    },
  ];
  for (const token of tokenAddresses) {
    const key = token.toLowerCase();
    const meta = tokenMeta.get(key)!;
    const total = aggregatedByToken.get(key) ?? 0n;
    publicBalancesAggregated.push({
      symbol: meta.symbol,
      token_address: token,
      decimals: meta.decimals,
      raw_token_holdings: total.toString(),
      formatted_token_holdings: formatUnits(total, meta.decimals),
    });
  }

  return {
    chainId: chainIdString,
    publicAggregated: filterNonZeroBalanceItems(publicBalancesAggregated),
    publicByAddress: filterPublicByAddress(publicByAddress),
    publicAccountIndexByAddress,
    privateRailgun: filterNonZeroBalanceItems(privateRailgun),
    privatePrivacyPools: filterNonZeroBalanceItems(privatePrivacyPools),
    privacyPoolsNotes:
      privacyPoolsNotes !== undefined
        ? filterNonZeroNotes(privacyPoolsNotes)
        : undefined,
  };
}
