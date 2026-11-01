import type { AssetAmount } from "@kohaku-eth/plugins";
import { formatUnits, getAddress, isAddress } from "viem";

import { formatCaughtError } from "../utils/cli-errors";
import { makePublicClient, disposePublicClient } from "../utils/rpc";
import { runWithSyncProgress } from "../utils/sync-progress.js";
import { isFirstProtocolSync } from "../utils/first-sync.js";
import { runWithWalletTrafficLog, withTor } from "../utils/tor";
import { withProtocolRuntime } from "./protocol-runtime";
import type { RailgunAdapter } from "./railgun-adapter";
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
import type { NoteDerivation } from "../utils/derivation-scheme.js";
import { mapPrivateBalanceRows } from "./private-balance-rows";
import {
  filterNonZeroNotes,
  mapPrivacyPoolsNotes,
  mapRailgunNotes,
  mapTornadoNotes,
  type PrivateNoteRow,
  type PrivateNotesByProtocol,
} from "./private-notes";
import { isAddressUsed } from "../utils/address-used.js";
import {
  adoptUsedPublicAccounts,
  makePublicAccountsStorage,
} from "../utils/public-accounts";
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
  /** Legacy-scheme portion of this row, when the protocol splits derivations. */
  legacy_raw_token_holdings?: string;
  legacy_formatted_token_holdings?: string;
};

export type BalancesSnapshot = {
  chainId: string;
  publicAggregated: BalanceItem[];
  publicByAddress: Record<string, BalanceItem[]>;
  publicAccountIndexByAddress: Record<string, number>;
  /** Stealth local index (`sN`) by address. */
  stealthAccountIndexByAddress: Record<string, number>;
  privateRailgun: BalanceItem[];
  railgunAddress?: string;
  privatePrivacyPools: BalanceItem[];
  privateTornado: BalanceItem[];
  legacyPrivacyPools: BalanceItem[];
  legacyTornado: BalanceItem[];
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

type ProtocolPrivateLoad = {
  balances: AssetAmount[];
  railgunAddress?: string;
  /** Legacy-scheme rows only. Omitted for Railgun. */
  legacyBalances?: AssetAmount[];
  rawNotes?: unknown[];
  notesError?: unknown;
};

function assetAmountKey(row: AssetAmount): string {
  const asset = row.asset as { __type?: string; contract?: unknown } | undefined;
  const tag = "tag" in row ? String((row as { tag?: string }).tag ?? "") : "";
  let assetKey = asset?.__type ?? "unknown";
  if (asset?.__type === "erc20") {
    const contract = asset.contract;
    assetKey =
      typeof contract === "bigint" ? contract.toString() : String(contract).toLowerCase();
  } else if (asset?.__type === "native") {
    assetKey = "native";
  }
  return `${assetKey}|${tag}`;
}

function sumAssetAmountRows(rows: readonly AssetAmount[]): AssetAmount[] {
  const merged = new Map<string, AssetAmount>();
  for (const row of rows) {
    const key = assetAmountKey(row);
    const prev = merged.get(key);
    if (!prev) {
      merged.set(key, { ...row, amount: row.amount });
      continue;
    }
    prev.amount += row.amount;
  }
  return [...merged.values()];
}

function tagNotes(notes: unknown[], derivation: NoteDerivation): unknown[] {
  return notes.map((note) =>
    note !== null && typeof note === "object"
      ? { ...(note as Record<string, unknown>), derivation }
      : note
  );
}

function balanceItemKey(row: BalanceItem): string {
  return `${row.token_address}|${row.symbol}|${row.status ?? ""}`;
}

function annotateLegacyHoldings(
  totals: BalanceItem[],
  legacy: BalanceItem[]
): BalanceItem[] {
  const byKey = new Map(legacy.map((row) => [balanceItemKey(row), row]));
  return totals.map((row) => {
    const leg = byKey.get(balanceItemKey(row));
    if (!leg || !isNonZeroRawHoldings(leg.raw_token_holdings)) return row;
    return {
      ...row,
      legacy_raw_token_holdings: leg.raw_token_holdings,
      legacy_formatted_token_holdings: leg.formatted_token_holdings,
    };
  });
}

async function loadPrivateProtocolData(
  protocol: SupportedProtocol,
  rpcUrl: string,
  walletDir: string,
  password: string,
  mnemonic: string,
  chainId: bigint,
  includeNotes: boolean,
  onSyncProgress?: (message: string) => void
): Promise<ProtocolPrivateLoad> {
  return runWithSyncProgress(
    {
      source: protocol,
      firstRun: isFirstProtocolSync(walletDir, protocol),
      onUpdate: onSyncProgress,
    },
    async () =>
      withProtocolRuntime(
        { protocol, rpcUrl, walletDir, password, mnemonic, chainId },
        async (_host, plugins) => {
          const readNotes = async (plugin: AnyPlugin): Promise<unknown[]> => {
            if (!plugin.notes) {
              throw new Error(`${protocol} plugin does not expose notes()`);
            }
            return plugin.notes(undefined, false);
          };
          if (protocol === "railgun") {
            const railgunAddress = (plugins.signature as RailgunAdapter).wallet.address;
            const balances = await plugins.signature.balance(undefined);
            if (!includeNotes) return { balances, railgunAddress };
            try {
              return { balances, railgunAddress, rawNotes: await readNotes(plugins.signature) };
            } catch (e) {
              return { balances, railgunAddress, notesError: e };
            }
          }

          // Legacy first, then signature, so the shared wallet file is not
          // written by two syncs at once.
          const legacyBalances = await plugins.legacy.balance(undefined);
          const signatureBalances = await plugins.signature.balance(undefined);
          const balances = sumAssetAmountRows([
            ...legacyBalances,
            ...signatureBalances,
          ]);
          if (!includeNotes) return { balances, legacyBalances };
          try {
            const legacyNotes = tagNotes(await readNotes(plugins.legacy), "legacy");
            const signatureNotes = tagNotes(
              await readNotes(plugins.signature),
              "signature"
            );
            return {
              balances,
              legacyBalances,
              rawNotes: [...legacyNotes, ...signatureNotes],
            };
          } catch (e) {
            return { balances, legacyBalances, notesError: e };
          }
        }
      )
  );
}

async function loadErc20Meta(
  client: Awaited<ReturnType<typeof makePublicClient>>,
  token: `0x${string}`
): Promise<{ symbol: string; decimals: number }> {
  let decimals: number;
  let symbol: string;
  try {
    const [decimalsResult, symbolResult] = await Promise.all([
      client.readContract({
        address: token,
        abi: ERC20_ABI,
        functionName: "decimals",
      }),
      client
        .readContract({
          address: token,
          abi: ERC20_ABI,
          functionName: "symbol",
        })
        .catch(() => "UNKNOWN" as const),
    ]);
    decimals = Number(decimalsResult);
    symbol = symbolResult;
  } catch {
    throw new Error(`Failed to read decimals() for token ${token}`);
  }
  if (!Number.isFinite(decimals)) {
    throw new Error(`Failed to read decimals() for token ${token}`);
  }
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
  /** Legacy-scheme rows only. Empty for Railgun and when that portion is zero. */
  legacyPrivacyPools: BalanceItem[];
  legacyTornado: BalanceItem[];
};

type ResolvedPrivateBalances = PrivateBalancesSnapshot & {
  railgunAddress?: string;
  erc20FromPrivate: `0x${string}`[];
  protocolAvailable: Partial<Record<SupportedProtocol, boolean>>;
  rawNotesByProtocol: Partial<Record<SupportedProtocol, unknown[]>>;
  notesErrors: Partial<Record<SupportedProtocol, unknown>>;
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
    | "verbose"
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
    verbose = false,
    onWarning,
    onSyncProgress,
  } = opts;
  const chainIdString = chainId.toString();

  let rgRows: AssetAmount[] = [];
  let railgunAddress: string | undefined;
  let ppRows: AssetAmount[] = [];
  let tcRows: AssetAmount[] = [];
  let ppLegacyRows: AssetAmount[] = [];
  let tcLegacyRows: AssetAmount[] = [];
  const protocolAvailable: Partial<Record<SupportedProtocol, boolean>> = {};
  const rawNotesByProtocol: Partial<Record<SupportedProtocol, unknown[]>> = {};
  const notesErrors: Partial<Record<SupportedProtocol, unknown>> = {};

  const loadOne = async (protocol: SupportedProtocol) => {
    const loaded = await loadPrivateProtocolData(
      protocol,
      rpcUrl,
      walletDir,
      password,
      mnemonic,
      chainId,
      verbose,
      onSyncProgress
    );
    if (loaded.rawNotes) rawNotesByProtocol[protocol] = loaded.rawNotes;
    if (loaded.notesError) notesErrors[protocol] = loaded.notesError;
    return loaded;
  };

  if (shouldIncludeProtocol("railgun", includeProtocols)) {
    try {
      const loaded = await loadOne("railgun");
      rgRows = loaded.balances;
      railgunAddress = loaded.railgunAddress;
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
      const loaded = await loadOne("privacy-pools");
      ppRows = loaded.balances;
      ppLegacyRows = loaded.legacyBalances ?? [];
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
      const loaded = await loadOne("tornado");
      tcRows = loaded.balances;
      tcLegacyRows = loaded.legacyBalances ?? [];
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

    const legacyPrivacyPools = filterNonZeroBalanceItems(
      mapPrivateBalanceRows(ppLegacyRows, tokenMeta)
    );
    const legacyTornado = filterNonZeroBalanceItems(
      mapPrivateBalanceRows(tcLegacyRows, tokenMeta)
    );
    return {
      privateRailgun: filterNonZeroBalanceItems(
        mapPrivateBalanceRows(rgRows, tokenMeta)
      ),
      railgunAddress,
      privatePrivacyPools: annotateLegacyHoldings(
        filterNonZeroBalanceItems(mapPrivateBalanceRows(ppRows, tokenMeta)),
        legacyPrivacyPools
      ),
      privateTornado: annotateLegacyHoldings(
        filterNonZeroBalanceItems(mapPrivateBalanceRows(tcRows, tokenMeta)),
        legacyTornado
      ),
      legacyPrivacyPools,
      legacyTornado,
      erc20FromPrivate,
      protocolAvailable,
      rawNotesByProtocol,
      notesErrors,
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
  const {
    privateRailgun,
    privatePrivacyPools,
    privateTornado,
    legacyPrivacyPools,
    legacyTornado,
  } = await withTor(
    useTor,
    { rpcUrl: opts.rpcUrl, onStatus: opts.onTorStatus, walletDir: opts.walletDir },
    () => resolvePrivateBalanceItems(opts)
  );
  const [
    pricedRailgun,
    pricedPrivacyPools,
    pricedTornado,
    pricedLegacyPrivacyPools,
    pricedLegacyTornado,
  ] = await attachUsdValuesToRowsLists(
    [
      privateRailgun,
      privatePrivacyPools,
      privateTornado,
      legacyPrivacyPools,
      legacyTornado,
    ],
    { chainId: opts.chainId, rpcUrl: opts.rpcUrl }
  );
  return {
    privateRailgun: pricedRailgun!,
    privatePrivacyPools: pricedPrivacyPools!,
    privateTornado: pricedTornado!,
    legacyPrivacyPools: pricedLegacyPrivacyPools!,
    legacyTornado: pricedLegacyTornado!,
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
    railgunAddress,
    privatePrivacyPools,
    privateTornado,
    legacyPrivacyPools,
    legacyTornado,
    erc20FromPrivate,
    protocolAvailable,
    rawNotesByProtocol,
    notesErrors,
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
        verbose,
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
  const rpcForPublic = await makePublicClient(rpcUrl);
  let publicAccounts = publicStorage.getAccounts();
  try {
    const adopted = await adoptUsedPublicAccounts(publicStorage, (address) =>
      isAddressUsed(address, rpcForPublic)
    );
    if (adopted.length > 0) {
      publicAccounts = publicStorage.getAccounts();
      onWarning?.(
        `Saved public account${adopted.length === 1 ? "" : "s"} that already had a nonce, balance, or code: ${adopted
          .map((account) => `[${account.index}] ${account.address}`)
          .join(", ")}.`
      );
    }
  } catch (e) {
    onWarning?.(
      `Could not check unstored public accounts: ${formatCaughtError(e)}`
    );
  }
  const publicAccountIndexByAddress: Record<string, number> = {};
  for (const acct of publicAccounts) {
    publicAccountIndexByAddress[acct.address] = acct.index;
  }

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
    await Promise.all(
      tokenAddresses.map(async (token) => {
        const key = token.toLowerCase();
        const known = knownMetaByLower.get(key);
        if (known) {
          tokenMeta.set(key, known);
        } else {
          tokenMeta.set(key, await loadErc20Meta(rpcForPublic, token));
        }
      })
    );

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
        const label =
          protocol === "privacy-pools"
            ? "Privacy pools"
            : protocol === "tornado"
              ? "Tornado Cash"
              : "Railgun";
        const notesError = notesErrors[protocol];
        if (notesError) {
          onWarning?.(
            `${label} notes unavailable: ${formatCaughtError(notesError)}`
          );
          privateNotes[protocol] = [];
          continue;
        }
        const raw = rawNotesByProtocol[protocol] ?? [];
        privateNotes[protocol] = filterNonZeroNotes(
          mapProtocolNotes(protocol, raw, tokenMeta)
        );
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

    // Fire all independent ETH + ERC-20 reads together so viem HTTP batching
    // packs them into one (or few) JSON-RPC POSTs.
    type EthSlot = { kind: "eth"; entryIndex: number; balance: bigint };
    type TokenSlot = {
      kind: "token";
      entryIndex: number;
      token: `0x${string}`;
      balance: bigint;
    };
    const balanceJobs: Array<Promise<EthSlot | TokenSlot>> = [];
    for (let entryIndex = 0; entryIndex < allSpendable.length; entryIndex++) {
      const entry = allSpendable[entryIndex]!;
      const address = entry.address as `0x${string}`;
      balanceJobs.push(
        rpcForPublic.getBalance({ address }).then((balance) => ({
          kind: "eth" as const,
          entryIndex,
          balance,
        }))
      );
      for (const token of tokenAddresses) {
        balanceJobs.push(
          rpcForPublic
            .readContract({
              address: token,
              abi: ERC20_ABI,
              functionName: "balanceOf",
              args: [address],
            })
            .then((balance) => ({
              kind: "token" as const,
              entryIndex,
              token,
              balance,
            }))
        );
      }
    }
    const balanceResults = await Promise.all(balanceJobs);

    const ethByEntry = new Map<number, bigint>();
    const tokenByEntry = new Map<number, Map<string, bigint>>();
    for (const result of balanceResults) {
      if (result.kind === "eth") {
        ethByEntry.set(result.entryIndex, result.balance);
        continue;
      }
      let byToken = tokenByEntry.get(result.entryIndex);
      if (!byToken) {
        byToken = new Map();
        tokenByEntry.set(result.entryIndex, byToken);
      }
      byToken.set(result.token.toLowerCase(), result.balance);
    }

    for (let entryIndex = 0; entryIndex < allSpendable.length; entryIndex++) {
      const entry = allSpendable[entryIndex]!;
      const ethBalance = ethByEntry.get(entryIndex) ?? 0n;
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

      const tokenBalances = tokenByEntry.get(entryIndex) ?? new Map();
      for (const token of tokenAddresses) {
        const key = token.toLowerCase();
        const bal = tokenBalances.get(key) ?? 0n;
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
      legacyPrivacyPools,
      legacyTornado,
    ],
    { chainId, rpcUrl }
  );

  const pricedPrivate = pricedRest.slice(-5);
  const pricedPublicByAddressLists = pricedRest.slice(0, -5);
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
    railgunAddress,
    privatePrivacyPools: pricedPrivate[1]!,
    privateTornado: pricedPrivate[2]!,
    legacyPrivacyPools: pricedPrivate[3]!,
    legacyTornado: pricedPrivate[4]!,
    privateNotes,
  };
}
