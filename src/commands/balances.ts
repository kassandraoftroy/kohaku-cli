import { log, spinner } from "@clack/prompts";
import chalk from "chalk";
import type { Command } from "commander";
import type { AssetAmount } from "@kohaku-eth/plugins";
import { Contract, formatUnits, getAddress, isAddress } from "ethers";

import { makeHost } from "../host/makeHost";
import { cliOptions } from "../utils/cli-command-options";
import { cliError, cliErrorFromCaught } from "../utils/cli-errors";
import {
  DEFAULT_DATA_DIR,
  getRpcChainIdMatchingWallet,
  makeEthersProvider,
  resolveRpcUrl,
} from "../utils/rpc";
import { ERC20_ABI, mergeDefaultAndExtraErc20s } from "../utils/tokens-util";
import {
  createProtocolPlugin,
  ETH_AS_ERC20,
  pluginIdForProtocol,
  type SupportedProtocol,
} from "../utils/plugins";
import {
  resolveWalletDir,
  resolveWalletNameOrPrompt,
  resolveWalletPassword,
} from "../utils/wallets-util";
import { readSeedKeystore } from "../utils/mnemonic";
import { makePublicAccountsStorage } from "../utils/public-accounts";

type BalancesOpts = {
  wallet?: string;
  password?: string;
  nonInteractive?: boolean;
  verbose?: boolean;
  rpcUrl?: string;
  tokensList?: string;
  dataDir?: string;
};

type BalanceItem = {
  symbol: string;
  token_address: string;
  decimals: number;
  raw_token_holdings: string;
  formatted_token_holdings: string;
};

type PrivateNoteRowJson = {
  label: string;
  balance_raw: string;
  balance_formatted: string;
  asset_address: string;
  approved: boolean;
  precommitment: string;
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

function filterNonZeroNotes(notes: PrivateNoteRowJson[]): PrivateNoteRowJson[] {
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
  const rpc = await makeEthersProvider(rpcUrl);
  try {
    const host = await makeHost({
      rpc,
      walletDir,
      password,
      mnemonic,
      pluginId: pluginIdForProtocol(protocol),
    });
    const plugin = await createProtocolPlugin(protocol, host, chainId);
    // Must await before `finally` runs — bare `return plugin.balance()` would destroy
    // the provider while the balance call is still in flight.
    return await plugin.balance(undefined);
  } finally {
    rpc.destroy();
  }
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
): Promise<PrivateNoteRowJson[]> {
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

function stringifyBalancesJson(payload: unknown): string {
  return JSON.stringify(
    payload,
    (_key, value) => (typeof value === "bigint" ? value.toString() : value),
    2
  );
}

function parseTokensList(raw: string | undefined): `0x${string}`[] {
  if (!raw?.trim()) return [];
  const parts = raw.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
  const seen = new Set<string>();
  const out: `0x${string}`[] = [];
  for (const p of parts) {
    if (!isAddress(p)) {
      throw new Error(`Invalid ERC20 address in --tokensList: ${p}`);
    }
    const addr = getAddress(p) as `0x${string}`;
    const key = addr.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(addr);
  }
  return out;
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

function padCell(s: string, width: number): string {
  const t = s.length > width ? `${s.slice(0, width - 1)}…` : s;
  return t.padEnd(width);
}

function shortenAddr(addr: string): string {
  if (addr.length < 14) return addr;
  return `${addr.slice(0, 8)}…${addr.slice(-6)}`;
}

const BAR = "═".repeat(62);
const THIN = "─".repeat(62);

function columnWidths(rows: BalanceItem[]): { symW: number; amtW: number } {
  let symW = 10;
  let amtW = 24;
  for (const r of rows) {
    symW = Math.max(symW, r.symbol.length);
    amtW = Math.max(amtW, r.formatted_token_holdings.length);
  }
  return { symW, amtW };
}

function printAggregatedTotalsTable(
  aggregated: BalanceItem[],
  sectionTitle = "  ■ Public — totals (all accounts)"
): void {
  console.log(chalk.bold(sectionTitle));
  console.log(chalk.dim(`  ${THIN}`));
  if (aggregated.length === 0) {
    console.log(chalk.dim("  (no non-zero balances)"));
    return;
  }
  const aggW = columnWidths(aggregated);
  console.log(
    chalk.dim(
      `  ${padCell("Symbol", aggW.symW)}  ${padCell("Balance", aggW.amtW)}  Token`
    )
  );
  for (const r of aggregated) {
    const tokenCol =
      r.token_address === "---"
        ? chalk.dim("native")
        : chalk.dim(shortenAddr(r.token_address));
    console.log(
      `  ${padCell(r.symbol, aggW.symW)}  ${padCell(r.formatted_token_holdings, aggW.amtW)}  ${tokenCol}`
    );
  }
}

function printBalanceItemRows(rows: BalanceItem[]): void {
  if (rows.length === 0) {
    console.log(chalk.dim("  (none)"));
    return;
  }
  const w = columnWidths(rows);
  console.log(
    chalk.dim(`  ${padCell("Symbol", w.symW)}  ${padCell("Balance", w.amtW)}  Token`)
  );
  for (const r of rows) {
    const tokenCol =
      r.token_address === "---"
        ? chalk.dim("native")
        : chalk.dim(shortenAddr(r.token_address));
    console.log(
      `  ${padCell(r.symbol, w.symW)}  ${padCell(r.formatted_token_holdings, w.amtW)}  ${tokenCol}`
    );
  }
}

function printHumanBalances(opts: {
  walletName: string;
  chainId: string;
  publicAggregated: BalanceItem[];
  publicByAddress: Record<string, BalanceItem[]>;
  privateRailgun: BalanceItem[];
  privatePrivacyPools: BalanceItem[];
  verbose: boolean;
  privacyPoolsNotes?: PrivateNoteRowJson[];
}): void {
  console.log();
  console.log(chalk.bold(` ${BAR}`));
  console.log(
    chalk.bold("  Balances"),
    chalk.dim("·"),
    chalk.cyan(opts.walletName),
    chalk.dim(`· chain ${opts.chainId}`)
  );
  console.log(chalk.bold(` ${BAR}`));
  console.log();

  printAggregatedTotalsTable(opts.publicAggregated);

  console.log();
  console.log(chalk.bold("  ■ Private — Railgun"));
  console.log(chalk.dim(`  ${THIN}`));
  printBalanceItemRows(opts.privateRailgun);

  console.log();
  console.log(chalk.bold("  ■ Private — Privacy pools"));
  console.log(chalk.dim(`  ${THIN}`));
  printBalanceItemRows(opts.privatePrivacyPools);

  if (opts.verbose) {
    console.log();
    console.log(chalk.bold("  ■ Public — by address"));
    console.log(chalk.dim(`  ${THIN}`));

    const addrs = Object.keys(opts.publicByAddress);
    if (addrs.length === 0) {
      console.log(chalk.dim("  (no non-zero balances)"));
    }

    for (const addr of addrs) {
      const rows = opts.publicByAddress[addr];
      if (!rows) continue;
      console.log();
      console.log(`  ${chalk.cyan.bold(addr)}`);
      console.log(chalk.dim(`  ${THIN}`));
      printBalanceItemRows(rows);
    }

    console.log();
    printAggregatedTotalsTable(
      opts.publicAggregated,
      "  ■ Public — totals (repeat)"
    );

    console.log();
    console.log(chalk.bold("  ■ Private — Railgun (aggregate)"));
    console.log(chalk.dim(`  ${THIN}`));
    printBalanceItemRows(opts.privateRailgun);

    console.log();
    console.log(chalk.bold("  ■ Private — Railgun (per-note detail)"));
    console.log(chalk.dim(`  ${THIN}`));
    console.log(
      chalk.dim(
        "  Railgun does not expose per-note rows in this CLI; see aggregate just above."
      )
    );

    console.log();
    console.log(chalk.bold("  ■ Private — Privacy pools (aggregate)"));
    console.log(chalk.dim(`  ${THIN}`));
    printBalanceItemRows(opts.privatePrivacyPools);

    console.log();
    console.log(chalk.bold("  ■ Private — Privacy pools (notes)"));
    console.log(chalk.dim(`  ${THIN}`));
    const notes = opts.privacyPoolsNotes ?? [];
    if (notes.length === 0) {
      console.log(chalk.dim("  (no notes)"));
    } else {
      for (const n of notes) {
        console.log(
          `  ${chalk.cyan(`label ${n.label}`)}  ${padCell(n.balance_formatted, 20)}  ${padCell(n.asset_address, 44)}  ${n.approved ? "approved" : "unapproved"}`
        );
      }
    }
  }

  console.log();
  console.log(chalk.bold(` ${BAR}`));
  console.log();
}

export function registerBalancesCommand(program: Command): void {
  program
    .command("balances")
    .description(
      "Public + private balances: ETH, default/extra ERC20s, Railgun & Privacy pools"
    )
    .option("--wallet <name>", cliOptions.walletBalancesOptional)
    .option("--password <password>", cliOptions.password)
    .option("--non-interactive", cliOptions.nonInteractiveBalances)
    .option(
      "--verbose",
      "Human: public by-address + repeated totals + Privacy pools notes (JSON: adds private_notes)"
    )
    .option("--rpc-url <url>", cliOptions.rpcUrl)
    .option(
      "--tokensList <addrs>",
      "Extra ERC20 addresses (comma/space); merged with chain defaults, deduped"
    )
    .option("--dataDir <path>", cliOptions.dataDir)
    .action(async (opts: BalancesOpts) => {
      const dataDir = opts.dataDir ?? DEFAULT_DATA_DIR;
      const walletName = await resolveWalletNameOrPrompt({
        dataDir,
        wallet: opts.wallet,
        nonInteractive: opts.nonInteractive,
      });
      if (!walletName) return;
      const rpcUrl = resolveRpcUrl(opts.rpcUrl);
      if (!rpcUrl) {
        cliError("Missing --rpc-url (or environment variable RPC_URL).");
        return;
      }

      let walletDir: string;
      try {
        walletDir = resolveWalletDir(dataDir, walletName);
      } catch (e) {
        cliErrorFromCaught(e);
        return;
      }

      const password = await resolveWalletPassword({
        flagPassword: opts.password,
        nonInteractive: opts.nonInteractive,
      });
      if (!password) return;

      let mnemonic: string;
      try {
        mnemonic = readSeedKeystore(password, walletDir);
      } catch (e) {
        cliErrorFromCaught(e);
        return;
      }

      let chainIdBn: bigint;
      try {
        chainIdBn = await getRpcChainIdMatchingWallet(rpcUrl, walletDir);
      } catch (e) {
        cliErrorFromCaught(e);
        return;
      }

      const chainIdString = chainIdBn.toString();

      let extraTokenAddresses: `0x${string}`[];
      try {
        extraTokenAddresses = parseTokensList(opts.tokensList);
      } catch (e) {
        cliErrorFromCaught(e);
        return;
      }

      const loading = spinner();
      loading.start("Loading balances...");

      let rgRows: AssetAmount[] = [];
      let ppRows: AssetAmount[] = [];
      // try {
      //   rgRows = await loadPrivateBalancesForProtocol(
      //     "railgun",
      //     rpcUrl,
      //     walletDir,
      //     password,
      //     mnemonic,
      //     chainIdBn
      //   );
      // } catch (e) {
      //   const msg = e instanceof Error ? e.message : String(e);
      //   log.warn(chalk.yellow(`Railgun private balances unavailable: ${msg}`));
      // }
      try {
        ppRows = await loadPrivateBalancesForProtocol(
          "privacy-pools",
          rpcUrl,
          walletDir,
          password,
          mnemonic,
          chainIdBn
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        log.warn(
          chalk.yellow(`Privacy pools private balances unavailable: ${msg}`)
        );
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

      try {
        const publicStorage = makePublicAccountsStorage(walletDir, mnemonic, password);
        const publicAccounts = publicStorage.getAccounts();

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
        let privacyPoolsNotesJson: PrivateNoteRowJson[] | undefined;
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

          if (opts.verbose) {
            try {
              privacyPoolsNotesJson = await loadPrivacyPoolsNotes(
                rpcUrl,
                walletDir,
                password,
                mnemonic,
                chainIdBn,
                tokenMeta
              );
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e);
              log.warn(
                chalk.yellow(`Privacy pools notes unavailable: ${msg}`)
              );
              privacyPoolsNotesJson = [];
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

        loading.stop("Balances loaded.");

        const publicAggregatedOut = filterNonZeroBalanceItems(publicBalancesAggregated);
        const publicByAddressOut = filterPublicByAddress(publicByAddress);
        const privateRailgunOut = filterNonZeroBalanceItems(privateRailgun);
        const privatePrivacyPoolsOut = filterNonZeroBalanceItems(privatePrivacyPools);
        const privacyPoolsNotesOut =
          privacyPoolsNotesJson !== undefined
            ? filterNonZeroNotes(privacyPoolsNotesJson)
            : undefined;

        const payload: Record<string, unknown> = {
          public_balances_aggregated: publicAggregatedOut,
          public_balances_by_address: publicByAddressOut,
          private_balances: {
            railgun: privateRailgunOut,
            "privacy-pools": privatePrivacyPoolsOut,
          },
        };
        if (opts.verbose) {
          payload.private_notes = {
            "privacy-pools": privacyPoolsNotesOut ?? [],
          };
        }

        if (opts.nonInteractive) {
          console.log(stringifyBalancesJson(payload));
        } else {
          printHumanBalances({
            walletName,
            chainId: chainIdString,
            publicAggregated: publicAggregatedOut,
            publicByAddress: publicByAddressOut,
            privateRailgun: privateRailgunOut,
            privatePrivacyPools: privatePrivacyPoolsOut,
            verbose: !!opts.verbose,
            privacyPoolsNotes: privacyPoolsNotesOut,
          });
        }
      } catch (e) {
        loading.stop("Balances failed.", 1);
        cliErrorFromCaught(e);
      }
    });
}
