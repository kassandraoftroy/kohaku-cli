import type { AssetAmount } from "@kohaku-eth/plugins";
import { formatUnits, getAddress, isAddress } from "viem";

import { formatCaughtError } from "../utils/cli-errors";
import { makePublicClient, disposePublicClient } from "../utils/rpc";
import { runWithSyncProgress } from "../utils/sync-progress.js";
import { isFirstProtocolSync } from "../utils/first-sync.js";
import { runWithWalletTrafficLog, withTor } from "../utils/tor";
import { withProtocolRuntime } from "./protocol-runtime";
import {
  ERC20_ABI,
  isPrivateBalanceNativeEth,
  mergeDefaultAndExtraErc20s,
} from "../utils/tokens-util";
import {
  shouldIncludeProtocol,
  type AnyPlugin,
  type SupportedProtocol,
} from "../utils/plugins";
import { mapPrivateBalanceRows } from "./private-balance-rows";
import {
  filterNonZeroNotes,
  mapPrivacyPoolsNotes,
  mapRailgunNotes,
  mapTornadoNotes,
  type PrivateNoteRow,
  type PrivateNotesByProtocol,
} from "./private-notes";
import { makePublicAccountsStorage } from "../utils/public-accounts";
import { deriveStealthKeypair } from "./stealth/keys.js";
import {
  formatStealthScanStartLog,
  resolveStealthScanWindow,
  scanAndImportStealthAnnouncements,
} from "./stealth/scan.js";
import { makeStealthAccountsStorage } from "./stealth/storage.js";
import {
  attachUsdValuesToRowsLists,
  USD_VALUE_UNAVAILABLE,
} from "./usd-values";

export type { PrivateNoteRow, PrivateNotesByProtocol };

export type BalanceItem = {
  symbol: string;
  token_address: string;
  decimals: number;
  raw_token_holdings: string;
  formatted_token_holdings: string;
  /** USD value of holdings (cents), or `"--"` on testnet / when unavailable. */
  usd_value: string;
  /** Spendability status for private protocol rows (e.g. spendable, pending). */
  status?: string;
};

export type BalancesSnapshot = {
  chainId: string;
  publicAggregated: BalanceItem[];
  publicByAddress: Record<string, BalanceItem[]>;
  publicAccountIndexByAddress: Record<string, number>;
  /** Stealth local index (`sN`) by address. */
  stealthAccountIndexByAddress: Record<string, number>;
  privateRailgun: BalanceItem[];
  privatePrivacyPools: BalanceItem[];
  privateTornado: BalanceItem[];
  privateNotes?: PrivateNotesByProtocol;
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
    if (isPrivateBalanceNativeEth(checksum)) continue;
    const k = checksum.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(checksum);
  }
  return out;
}

function mapProtocolNotes(
  protocol: SupportedProtocol,
  notes: unknown[],
  tokenMeta: Map<string, { symbol: string; decimals: number }>
): PrivateNoteRow[] {
  if (protocol === "privacy-pools") {
    return mapPrivacyPoolsNotes(notes, tokenMeta);
  }
  if (protocol === "tornado") {
    return mapTornadoNotes(notes, tokenMeta);
  }
  return mapRailgunNotes(notes, tokenMeta);
}

async function loadProtocolNotes(
  protocol: SupportedProtocol,
  rpcUrl: string,
  walletDir: string,
  password: string,
  mnemonic: string,
  chainId: bigint,
  tokenMeta: Map<string, { symbol: string; decimals: number }>,
  onSyncProgress?: (message: string) => void
): Promise<PrivateNoteRow[]> {
  const notes = await runWithSyncProgress(
    {
      source: protocol,
      firstRun: isFirstProtocolSync(walletDir, protocol),
      onUpdate: onSyncProgress,
    },
    async () =>
      withProtocolRuntime(
        { protocol, rpcUrl, walletDir, password, mnemonic, chainId },
        async (_host, plugin) => {
          const notesFn = (plugin as AnyPlugin).notes;
          if (!notesFn) {
            throw new Error(`${protocol} plugin does not expose notes()`);
          }
          // Preserve method `this` binding for class-based plugin implementations.
          return (plugin as AnyPlugin).notes!(undefined, false);
        }
      )
  );
  return mapProtocolNotes(protocol, notes, tokenMeta);
}

async function loadPrivateBalancesForProtocol(
  protocol: SupportedProtocol,
  rpcUrl: string,
  walletDir: string,
  password: string,
  mnemonic: string,
  chainId: bigint,
  onSyncProgress?: (message: string) => void
): Promise<AssetAmount[]> {
  return runWithSyncProgress(
    {
      source: protocol,
      firstRun: isFirstProtocolSync(walletDir, protocol),
      onUpdate: onSyncProgress,
    },
    async () =>
      withProtocolRuntime(
        { protocol, rpcUrl, walletDir, password, mnemonic, chainId },
        async (_host, plugin) => plugin.balance(undefined)
      )
  );
}

async function loadErc20Meta(
  client: Awaited<ReturnType<typeof makePublicClient>>,
  token: `0x${string}`
): Promise<{ symbol: string; decimals: number }> {
  let decimals: number;
  try {
    decimals = Number(
      await client.readContract({
        address: token,
        abi: ERC20_ABI,
        functionName: "decimals",
      })
    );
  } catch {
    throw new Error(`Failed to read decimals() for token ${token}`);
  }
  const symbol = await client.readContract({
    address: token,
    abi: ERC20_ABI,
    functionName: "symbol",
  }).catch(() => "UNKNOWN");
  return { symbol, decimals };
}

export type LoadBalancesSnapshotOptions = {
  rpcUrl: string;
  walletDir: string;
  password: string;
  mnemonic: string;
  chainId: bigint;
  extraTokenAddresses?: `0x${string}`[];
  /** When set, only these private protocols are synced. Omit for all. */
  includeProtocols?: SupportedProtocol[] | null;
  verbose?: boolean;
  onWarning?: (message: string) => void;
  /** Skip Tor for privacy HTTP (default: Tor on when private protocols sync). */
  withoutTor?: boolean;
  onTorStatus?: (message: string) => void;
  /** Live first-sync progress (saga chunks, RPC windows, Subsquid/ASP). */
  onSyncProgress?: (message: string) => void;
  /**
   * Lower bound for the ERC-5564 announcement scan (inclusive).
   * When set on a first/full history pass, skips announcer history before this block.
   */
  stealthStartBlock?: bigint;
  /**
   * When true, `stealthStartBlock` came from `--stealth-start-block` and may
   * start below lastScannedBlock (back-date). Do not set this for the wallet
   * file — that is passed as stealthStartBlock on every incremental run.
   */
  stealthStartBlockBackdate?: boolean;
  /**
   * Skip ERC-5564 announcement discovery. Already-imported stealth accounts
   * are still included in public balances.
   */
  skipStealthScan?: boolean;
  /**
   * Durable "Stealth scan from block …" line. Omit in quiet / --non-interactive
   * mode so JSON stdout stays clean.
   */
  onStealthScanStart?: (message: string) => void;
};

export type PrivateBalancesSnapshot = {
  privateRailgun: BalanceItem[];
  privatePrivacyPools: BalanceItem[];
  privateTornado: BalanceItem[];
};

type ResolvedPrivateBalances = PrivateBalancesSnapshot & {
  erc20FromPrivate: `0x${string}`[];
  protocolAvailable: Partial<Record<SupportedProtocol, boolean>>;
};

function willSyncPrivateProtocols(
  includeProtocols: SupportedProtocol[] | null
): boolean {
  // null = sync all private protocols (TUI / callers that omit the filter)
  return includeProtocols === null || includeProtocols.length > 0;
}

async function resolvePrivateBalanceItems(
  opts: Pick<
    LoadBalancesSnapshotOptions,
    | "rpcUrl"
    | "walletDir"
    | "password"
    | "mnemonic"
    | "chainId"
    | "includeProtocols"
    | "onWarning"
    | "onSyncProgress"
  >
): Promise<ResolvedPrivateBalances> {
  const {
    rpcUrl,
    walletDir,
    password,
    mnemonic,
    chainId,
    includeProtocols = null,
    onWarning,
    onSyncProgress,
  } = opts;
  const chainIdString = chainId.toString();

  let rgRows: AssetAmount[] = [];
  let ppRows: AssetAmount[] = [];
  let tcRows: AssetAmount[] = [];
  const protocolAvailable: Partial<Record<SupportedProtocol, boolean>> = {};

  if (shouldIncludeProtocol("railgun", includeProtocols)) {
    try {
      rgRows = await loadPrivateBalancesForProtocol(
        "railgun",
        rpcUrl,
        walletDir,
        password,
        mnemonic,
        chainId,
        onSyncProgress
      );
      protocolAvailable.railgun = true;
    } catch (e) {
      onWarning?.(
        `Railgun private balances unavailable: ${formatCaughtError(e)}`
      );
      protocolAvailable.railgun = false;
    }
  }

  if (shouldIncludeProtocol("privacy-pools", includeProtocols)) {
    try {
      ppRows = await loadPrivateBalancesForProtocol(
        "privacy-pools",
        rpcUrl,
        walletDir,
        password,
        mnemonic,
        chainId,
        onSyncProgress
      );
      protocolAvailable["privacy-pools"] = true;
    } catch (e) {
      onWarning?.(
        `Privacy pools private balances unavailable: ${formatCaughtError(e)}`
      );
      protocolAvailable["privacy-pools"] = false;
    }
  }

  if (shouldIncludeProtocol("tornado", includeProtocols)) {
    try {
      tcRows = await loadPrivateBalancesForProtocol(
        "tornado",
        rpcUrl,
        walletDir,
        password,
        mnemonic,
        chainId,
        onSyncProgress
      );
      protocolAvailable.tornado = true;
    } catch (e) {
      onWarning?.(
        `Tornado Cash private balances unavailable: ${formatCaughtError(e)}`
      );
      protocolAvailable.tornado = false;
    }
  }
  const erc20FromPrivate = [
    ...collectErc20AddressesFromPrivateBalances(rgRows),
    ...collectErc20AddressesFromPrivateBalances(ppRows),
    ...collectErc20AddressesFromPrivateBalances(tcRows),
  ];

  const { erc20Addresses: tokenAddresses, knownMetaByLower } =
    mergeDefaultAndExtraErc20s(chainIdString, erc20FromPrivate);

  const client = await makePublicClient(rpcUrl);
  const tokenMeta = new Map<string, { symbol: string; decimals: number }>();
  try {
    for (const token of tokenAddresses) {
      const key = token.toLowerCase();
      const known = knownMetaByLower.get(key);
      if (known) {
        tokenMeta.set(key, known);
      } else {
        tokenMeta.set(key, await loadErc20Meta(client, token));
      }
    }

    return {
      privateRailgun: filterNonZeroBalanceItems(
        mapPrivateBalanceRows(rgRows, tokenMeta)
      ),
      privatePrivacyPools: filterNonZeroBalanceItems(
        mapPrivateBalanceRows(ppRows, tokenMeta)
      ),
      privateTornado: filterNonZeroBalanceItems(
        mapPrivateBalanceRows(tcRows, tokenMeta)
      ),
      erc20FromPrivate,
      protocolAvailable,
    };
  } finally {
    disposePublicClient(client);
  }
}

export async function loadPrivateBalancesOnly(
  opts: Pick<
    LoadBalancesSnapshotOptions,
    | "rpcUrl"
    | "walletDir"
    | "password"
    | "mnemonic"
    | "chainId"
    | "includeProtocols"
    | "onWarning"
    | "withoutTor"
    | "onTorStatus"
    | "onSyncProgress"
  >
): Promise<PrivateBalancesSnapshot> {
  const includeProtocols = opts.includeProtocols ?? null;
  const useTor =
    !opts.withoutTor && willSyncPrivateProtocols(includeProtocols);
  const { privateRailgun, privatePrivacyPools, privateTornado } = await withTor(
    useTor,
    { rpcUrl: opts.rpcUrl, onStatus: opts.onTorStatus, walletDir: opts.walletDir },
    () => resolvePrivateBalanceItems(opts)
  );
  const [pricedRailgun, pricedPrivacyPools, pricedTornado] =
    await attachUsdValuesToRowsLists(
      [privateRailgun, privatePrivacyPools, privateTornado],
      { chainId: opts.chainId, rpcUrl: opts.rpcUrl }
    );
  return {
    privateRailgun: pricedRailgun!,
    privatePrivacyPools: pricedPrivacyPools!,
    privateTornado: pricedTornado!,
  };
}

export async function loadBalancesSnapshot(
  opts: LoadBalancesSnapshotOptions
): Promise<BalancesSnapshot> {
  return runWithWalletTrafficLog(opts.walletDir, () =>
    loadBalancesSnapshotInner(opts)
  );
}

async function loadBalancesSnapshotInner(
  opts: LoadBalancesSnapshotOptions
): Promise<BalancesSnapshot> {
  const {
    rpcUrl,
    walletDir,
    password,
    mnemonic,
    chainId,
    extraTokenAddresses = [],
    includeProtocols = null,
    verbose = false,
    onWarning,
    withoutTor,
    onTorStatus,
    onSyncProgress,
    skipStealthScan,
    stealthStartBlockBackdate,
    onStealthScanStart,
  } = opts;
  const chainIdString = chainId.toString();

  const useTor = !withoutTor && willSyncPrivateProtocols(includeProtocols);

  const {
    privateRailgun,
    privatePrivacyPools,
    privateTornado,
    erc20FromPrivate,
    protocolAvailable,
  } = await withTor(
    useTor,
    { rpcUrl, onStatus: onTorStatus, walletDir },
    () =>
      resolvePrivateBalanceItems({
        rpcUrl,
        walletDir,
        password,
        mnemonic,
        chainId,
        includeProtocols,
        onWarning,
        onSyncProgress,
      })
  );

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

  const rpcForPublic = await makePublicClient(rpcUrl);
  const stealthAccountIndexByAddress: Record<string, number> = {};
  let stealthAccounts: ReturnType<
    ReturnType<typeof makeStealthAccountsStorage>["getAccounts"]
  > = [];
    try {
    // Discover new stealth payments before aggregating public balances.
    if (!skipStealthScan) {
      try {
        const keypair = deriveStealthKeypair(mnemonic, chainId);
        const stealthStore = makeStealthAccountsStorage(
          walletDir,
          password
        ).getStore();
        const latest = await rpcForPublic.getBlockNumber();
        const window = resolveStealthScanWindow({
          chainId,
          latest,
          startFromBlock: opts.stealthStartBlock,
          lastScannedBlock: stealthStore.lastScannedBlock,
          fullHistoryScanned: stealthStore.fullHistoryScanned,
          backdate: stealthStartBlockBackdate,
        });
        const prelude =
          onStealthScanStart && window.fromBlock <= window.latest
            ? formatStealthScanStartLog(window.fromBlock, window.latest)
            : undefined;
        if (prelude && !process.stdout.isTTY) {
          onStealthScanStart?.(prelude);
        }
        await runWithSyncProgress(
          // The scan itself reports whether this is a first pass.
          { source: "stealth", onUpdate: onSyncProgress, prelude },
          () =>
            scanAndImportStealthAnnouncements({
              client: rpcForPublic,
              walletDir,
              password,
              keypair,
              chainId,
              startFromBlock: opts.stealthStartBlock,
              backdate: stealthStartBlockBackdate,
              latest,
            })
        );
      } catch (e) {
        onWarning?.(
          `Stealth announcement scan skipped: ${formatCaughtError(e)}`
        );
      }
    }
    stealthAccounts = makeStealthAccountsStorage(walletDir, password).getAccounts();
    for (const acct of stealthAccounts) {
      stealthAccountIndexByAddress[acct.address] = acct.stealthIndex;
    }
  } catch (e) {
    onWarning?.(`Stealth accounts unavailable: ${formatCaughtError(e)}`);
  }

  const publicByAddress: Record<string, BalanceItem[]> = {};
  const aggregatedEth: bigint[] = [];
  const aggregatedByToken = new Map<string, bigint>();
  for (const t of tokenAddresses) {
    aggregatedByToken.set(t.toLowerCase(), 0n);
  }

  const tokenMeta = new Map<string, { symbol: string; decimals: number }>();
  let privateNotes: PrivateNotesByProtocol | undefined;
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

    if (verbose) {
      privateNotes = {};
      const protocolsToNotes: SupportedProtocol[] = [
        "railgun",
        "privacy-pools",
        "tornado",
      ];
      for (const protocol of protocolsToNotes) {
        if (!shouldIncludeProtocol(protocol, includeProtocols)) continue;
        if (protocolAvailable[protocol] === false) {
          privateNotes[protocol] = [];
          continue;
        }
        try {
          const rows = await loadProtocolNotes(
            protocol,
            rpcUrl,
            walletDir,
            password,
            mnemonic,
            chainId,
            tokenMeta,
            onSyncProgress
          );
          privateNotes[protocol] = filterNonZeroNotes(rows);
        } catch (e) {
          const label =
            protocol === "privacy-pools"
              ? "Privacy pools"
              : protocol === "tornado"
                ? "Tornado Cash"
                : "Railgun";
          onWarning?.(
            `${label} notes unavailable: ${formatCaughtError(e)}`
          );
          privateNotes[protocol] = [];
        }
      }
    }

    const now = Date.now();
    const updatedAccounts: typeof publicAccounts = [];
    const updatedStealth: typeof stealthAccounts = [];
    const allSpendable: Array<{
      address: string;
      ethBalanceKey: "hd" | "stealth";
      hd?: (typeof publicAccounts)[number];
      stealth?: (typeof stealthAccounts)[number];
    }> = [
      ...publicAccounts.map((hd) => ({
        address: hd.address,
        ethBalanceKey: "hd" as const,
        hd,
      })),
      ...stealthAccounts.map((stealth) => ({
        address: stealth.address,
        ethBalanceKey: "stealth" as const,
        stealth,
      })),
    ];

    for (const entry of allSpendable) {
      const ethBalance = await rpcForPublic.getBalance({
        address: entry.address as `0x${string}`,
      });
      aggregatedEth.push(ethBalance);

      const priorErc20 =
        entry.hd?.erc20Balances ?? entry.stealth?.erc20Balances ?? {};
      const erc20Balances = { ...priorErc20 };
      const rows: BalanceItem[] = [
        {
          symbol: "ETH",
          token_address: "---",
          decimals: 18,
          raw_token_holdings: ethBalance.toString(),
          formatted_token_holdings: formatUnits(ethBalance, 18),
          usd_value: USD_VALUE_UNAVAILABLE,
        },
      ];

      for (const token of tokenAddresses) {
        const key = token.toLowerCase();
        const bal = await rpcForPublic.readContract({
          address: token,
          abi: ERC20_ABI,
          functionName: "balanceOf",
          args: [entry.address as `0x${string}`],
        });
        erc20Balances[key] = bal.toString();
        aggregatedByToken.set(key, (aggregatedByToken.get(key) ?? 0n) + bal);
        const meta = tokenMeta.get(key)!;
        rows.push({
          symbol: meta.symbol,
          token_address: token,
          decimals: meta.decimals,
          raw_token_holdings: bal.toString(),
          formatted_token_holdings: formatUnits(bal, meta.decimals),
          usd_value: USD_VALUE_UNAVAILABLE,
        });
      }

      if (entry.hd) {
        updatedAccounts.push({
          ...entry.hd,
          ethBalance: ethBalance.toString(),
          erc20Balances,
          lastUpdated: now,
        });
      }
      if (entry.stealth) {
        updatedStealth.push({
          ...entry.stealth,
          ethBalance: ethBalance.toString(),
          erc20Balances,
          lastUpdated: now,
        });
      }

      publicByAddress[entry.address] = rows;
    }

    if (updatedAccounts.length > 0) {
      publicStorage.setAccounts(updatedAccounts);
    }
    if (updatedStealth.length > 0) {
      const stealthStorage = makeStealthAccountsStorage(walletDir, password);
      for (const acct of updatedStealth) {
        stealthStorage.upsertAccount(acct);
      }
    }
  } finally {
    disposePublicClient(rpcForPublic);
  }

  const totalPublicEth = aggregatedEth.reduce((a, b) => a + b, 0n);

  const publicBalancesAggregated: BalanceItem[] = [
    {
      symbol: "ETH",
      token_address: "---",
      decimals: 18,
      raw_token_holdings: totalPublicEth.toString(),
      formatted_token_holdings: formatUnits(totalPublicEth, 18),
      usd_value: USD_VALUE_UNAVAILABLE,
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
      usd_value: USD_VALUE_UNAVAILABLE,
    });
  }

  const filteredPublicAggregated = filterNonZeroBalanceItems(
    publicBalancesAggregated
  );
  const filteredPublicByAddress = filterPublicByAddress(publicByAddress);

  // Price all balance rows once (shared unit prices). Testnet → "--".
  const publicByAddressEntries = Object.entries(filteredPublicByAddress);
  const [
    publicAggregatedPriced,
    ...pricedRest
  ] = await attachUsdValuesToRowsLists(
    [
      filteredPublicAggregated,
      ...publicByAddressEntries.map(([, rows]) => rows),
      privateRailgun,
      privatePrivacyPools,
      privateTornado,
    ],
    { chainId, rpcUrl }
  );

  const pricedPrivate = pricedRest.slice(-3);
  const pricedPublicByAddressLists = pricedRest.slice(0, -3);
  const publicByAddressPriced: Record<string, BalanceItem[]> = {};
  for (let i = 0; i < publicByAddressEntries.length; i++) {
    publicByAddressPriced[publicByAddressEntries[i]![0]] =
      pricedPublicByAddressLists[i]!;
  }

  return {
    chainId: chainIdString,
    publicAggregated: publicAggregatedPriced!,
    publicByAddress: publicByAddressPriced,
    publicAccountIndexByAddress,
    stealthAccountIndexByAddress,
    privateRailgun: pricedPrivate[0]!,
    privatePrivacyPools: pricedPrivate[1]!,
    privateTornado: pricedPrivate[2]!,
    privateNotes,
  };
}
