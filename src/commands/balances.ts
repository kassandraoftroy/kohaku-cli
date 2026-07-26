import { log, spinner } from "@clack/prompts";
import chalk from "chalk";
import type { Command } from "commander";
import { getAddress, isAddress } from "ethers";

import type { BalanceItem } from "../lib/balances-snapshot";
import { loadBalancesSnapshot } from "../lib/balances-snapshot";
import {
  formatDepositTimestampIso,
  formatNoteAssetLabel,
  type PrivateNoteRow,
} from "../lib/private-notes";
import { cliOptions } from "../utils/cli-command-options";
import { quietNonInteractive, runQuietSpinner } from "../utils/cli-quiet";
import { cliError, cliErrorFromCaught } from "../utils/cli-errors";
import {
  DEFAULT_DATA_DIR,
  getRpcChainIdMatchingWallet,
  resolveRpcUrl,
} from "../utils/rpc";
import {
  resolveIncludeProtocols,
  shouldIncludeProtocol,
  SUPPORTED_PROTOCOLS_HELP,
  type SupportedProtocol,
} from "../utils/plugins";
import {
  resolveWalletDir,
  resolveWalletNameOrPrompt,
  resolveWalletPassword,
} from "../utils/wallets-util";
import { readSeedKeystore } from "../utils/mnemonic";

type BalancesOpts = {
  wallet?: string;
  password?: string;
  nonInteractive?: boolean;
  verbose?: boolean;
  include?: string;
  rpcUrl?: string;
  tokensList?: string;
  dataDir?: string;
};

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

function columnWidths(
  rows: BalanceItem[],
  showStatus: boolean
): { symW: number; amtW: number; usdW: number; statusW: number } {
  let symW = 10;
  let amtW = 24;
  let usdW = 10;
  let statusW = showStatus ? 8 : 0;
  for (const r of rows) {
    symW = Math.max(symW, r.symbol.length);
    amtW = Math.max(amtW, r.formatted_token_holdings.length);
    usdW = Math.max(usdW, formatUsdDisplay(r.usd_value).length);
    if (showStatus && r.status) {
      statusW = Math.max(statusW, r.status.length);
    }
  }
  return { symW, amtW, usdW, statusW };
}

function formatUsdDisplay(usdValue: string): string {
  if (usdValue === "--") return "--";
  return `$${usdValue}`;
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
  const aggW = columnWidths(aggregated, false);
  console.log(
    chalk.dim(
      `  ${padCell("Symbol", aggW.symW)}  ${padCell("Balance", aggW.amtW)}  ${padCell("USD", aggW.usdW)}  Token`
    )
  );
  for (const r of aggregated) {
    const tokenCol =
      r.token_address === "---"
        ? chalk.dim("native")
        : chalk.dim(shortenAddr(r.token_address));
    console.log(
      `  ${padCell(r.symbol, aggW.symW)}  ${padCell(r.formatted_token_holdings, aggW.amtW)}  ${padCell(formatUsdDisplay(r.usd_value), aggW.usdW)}  ${tokenCol}`
    );
  }
}

function printBalanceItemRows(
  rows: BalanceItem[],
  opts?: { status?: boolean }
): void {
  if (rows.length === 0) {
    console.log(chalk.dim("  (none)"));
    return;
  }
  const showStatus = opts?.status ?? rows.some((r) => r.status);
  const w = columnWidths(rows, showStatus);
  const statusHdr = showStatus ? `  ${padCell("Status", w.statusW)}` : "";
  console.log(
    chalk.dim(
      `  ${padCell("Symbol", w.symW)}  ${padCell("Balance", w.amtW)}  ${padCell("USD", w.usdW)}${statusHdr}  Token`
    )
  );
  for (const r of rows) {
    const tokenCol =
      r.token_address === "---"
        ? chalk.dim("native")
        : chalk.dim(shortenAddr(r.token_address));
    const statusCol = showStatus
      ? `  ${padCell(r.status ?? "—", w.statusW)}`
      : "";
    console.log(
      `  ${padCell(r.symbol, w.symW)}  ${padCell(r.formatted_token_holdings, w.amtW)}  ${padCell(formatUsdDisplay(r.usd_value), w.usdW)}${statusCol}  ${tokenCol}`
    );
  }
}

function printPrivateProtocolSection(
  title: string,
  rows: BalanceItem[],
  opts?: { status?: boolean }
): void {
  console.log();
  console.log(chalk.bold(`  ■ ${title}`));
  console.log(chalk.dim(`  ${THIN}`));
  printBalanceItemRows(rows, opts);
}

function printPrivateNoteRow(n: PrivateNoteRow): void {
  const asset = formatNoteAssetLabel(n);
  if (n.protocol === "privacy-pools") {
    const label = n.label ? chalk.cyan(`label ${n.label}`) : chalk.cyan("note");
    console.log(
      `  ${label}  ${padCell(n.balance_formatted, 20)}  ${padCell(asset, 12)}  ${n.approved ? "approved" : "pending"}`
    );
    return;
  }
  if (n.protocol === "tornado") {
    const id = n.deposit_index ? `deposit #${n.deposit_index}` : "note";
    console.log(
      `  ${chalk.cyan(id)}  ${padCell(n.balance_formatted, 20)}  ${padCell(asset, 12)}  ${padCell(formatDepositTimestampIso(n.deposit_timestamp), 22)}  ${n.status ?? ""}`
    );
    return;
  }
  const id = n.railgun_address
    ? shortenAddr(n.railgun_address)
    : `tree ${n.tree_number ?? "?"}`;
  console.log(
    `  ${chalk.cyan(id)}  ${padCell(n.balance_formatted, 20)}  ${padCell(asset, 12)}  ${n.status ?? ""}`
  );
}

function printHumanBalances(opts: {
  walletName: string;
  chainId: string;
  publicAggregated: BalanceItem[];
  publicByAddress: Record<string, BalanceItem[]>;
  publicAccountIndexByAddress?: Record<string, number>;
  privateRailgun: BalanceItem[];
  privatePrivacyPools: BalanceItem[];
  privateTornado: BalanceItem[];
  includeProtocols: SupportedProtocol[];
  verbose: boolean;
  privateNotes?: Partial<Record<SupportedProtocol, PrivateNoteRow[]>>;
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

  if (opts.includeProtocols.length === 0) {
    console.log();
    console.log(
      chalk.yellow(
        "  No private protocol balances shown. Pass --include <protocols> or set DEFAULT_PRIVACY_PROTOCOL."
      )
    );
  }

  if (shouldIncludeProtocol("railgun", opts.includeProtocols)) {
    printPrivateProtocolSection("Private — Railgun", opts.privateRailgun, {
      status: true,
    });
  }

  if (shouldIncludeProtocol("privacy-pools", opts.includeProtocols)) {
    printPrivateProtocolSection(
      "Private — Privacy pools",
      opts.privatePrivacyPools,
      { status: true }
    );
  }

  if (shouldIncludeProtocol("tornado", opts.includeProtocols)) {
    printPrivateProtocolSection(
      "Private — Tornado Cash",
      opts.privateTornado,
      { status: true }
    );
  }

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
      const index = opts.publicAccountIndexByAddress?.[addr];
      console.log();
      console.log(
        index !== undefined
          ? `  ${chalk.cyan.bold(`[${index}]`)} ${chalk.cyan.bold(addr)}`
          : `  ${chalk.cyan.bold(addr)}`
      );
      console.log(chalk.dim(`  ${THIN}`));
      printBalanceItemRows(rows);
    }

    const noteSections: Array<{ title: string; protocol: SupportedProtocol }> = [
      { title: "Private — Railgun (notes)", protocol: "railgun" },
      { title: "Private — Privacy pools (notes)", protocol: "privacy-pools" },
      { title: "Private — Tornado Cash (notes)", protocol: "tornado" },
    ];
    for (const { title, protocol } of noteSections) {
      if (!shouldIncludeProtocol(protocol, opts.includeProtocols)) continue;
      const notes = opts.privateNotes?.[protocol];
      if (notes === undefined) continue;
      console.log();
      console.log(chalk.bold(`  ■ ${title}`));
      console.log(chalk.dim(`  ${THIN}`));
      if (notes.length === 0) {
        console.log(chalk.dim("  (no notes)"));
      } else {
        for (const n of notes) {
          printPrivateNoteRow(n);
        }
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
      "Public + private balances: ETH, default/extra ERC20s; private protocols via --include or DEFAULT_PRIVACY_PROTOCOL"
    )
    .option("--wallet <name>", cliOptions.walletBalancesOptional)
    .option("--password <password>", cliOptions.password)
    .option("--non-interactive", cliOptions.nonInteractiveBalances)
    .option(
      "--verbose",
      "Human: public by-address breakdown + per-protocol private notes (JSON: adds private_notes)"
    )
    .option(
      "--include <protocols>",
      `Comma-separated private protocols to sync (default: DEFAULT_PRIVACY_PROTOCOL, or none). e.g. ${SUPPORTED_PROTOCOLS_HELP.replace(/ \| /g, ",")}`
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
        validate: (candidate) => {
          readSeedKeystore(candidate, walletDir);
        },
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

      let includeProtocols: SupportedProtocol[];
      try {
        includeProtocols = resolveIncludeProtocols(opts.include);
      } catch (e) {
        cliErrorFromCaught(e);
        return;
      }

      const quiet = quietNonInteractive(opts.nonInteractive);
      const loading = spinner();
      try {
        await runQuietSpinner(
          quiet,
          loading,
          { start: "Loading balances...", failure: "Balances failed." },
          async () => {
            const snap = await loadBalancesSnapshot({
              rpcUrl,
              walletDir,
              password,
              mnemonic,
              chainId: chainIdBn,
              extraTokenAddresses,
              includeProtocols,
              verbose: !!opts.verbose,
              onWarning: (msg) => {
                if (!quiet) {
                  log.warn(chalk.yellow(msg));
                }
              },
            });

            const privateNotesOut = snap.privateNotes;

            const privateBalances: Record<string, BalanceItem[]> = {};
            if (shouldIncludeProtocol("railgun", includeProtocols)) {
              privateBalances.railgun = snap.privateRailgun;
            }
            if (shouldIncludeProtocol("privacy-pools", includeProtocols)) {
              privateBalances["privacy-pools"] = snap.privatePrivacyPools;
            }
            if (shouldIncludeProtocol("tornado", includeProtocols)) {
              privateBalances.tornado = snap.privateTornado;
            }

            const payload: Record<string, unknown> = {
              public_balances_aggregated: snap.publicAggregated,
              public_balances_by_address: snap.publicByAddress,
              private_balances: privateBalances,
            };

            if (opts.verbose) {
              const publicAccountIndexesOut: Record<string, number> = {};
              for (const addr of Object.keys(snap.publicByAddress)) {
                const idx = snap.publicAccountIndexByAddress[addr];
                if (idx !== undefined) {
                  publicAccountIndexesOut[addr] = idx;
                }
              }
              payload.public_account_indexes_by_address = publicAccountIndexesOut;
              if (privateNotesOut) {
                payload.private_notes = privateNotesOut;
              }
            }

            if (opts.nonInteractive) {
              console.log(stringifyBalancesJson(payload));
            } else {
              printHumanBalances({
                walletName,
                chainId: chainIdString,
                publicAggregated: snap.publicAggregated,
                publicByAddress: snap.publicByAddress,
                publicAccountIndexByAddress: snap.publicAccountIndexByAddress,
                privateRailgun: snap.privateRailgun,
                privatePrivacyPools: snap.privatePrivacyPools,
                privateTornado: snap.privateTornado,
                includeProtocols,
                verbose: !!opts.verbose,
                privateNotes: privateNotesOut,
              });
            }
          },
          () => "Balances loaded."
        );
      } catch (e) {
        cliErrorFromCaught(e);
        return;
      }
    });
}
