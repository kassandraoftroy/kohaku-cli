import { createEthereumNames } from "@1001-digital/ethereum-names";
import {
  resolveStealthMetaAddress,
} from "eth-stealth-address-resolver";
import { log, spinner } from "@clack/prompts";
import chalk from "chalk";
import type { Command } from "commander";
import { getAddress, isAddress } from "viem";

import type { BalanceItem } from "../lib/balances-snapshot";
import { loadBalancesSnapshot } from "../lib/balances-snapshot";
import {
  formatDepositTimestampIso,
  formatNoteAssetLabel,
  type PrivateNoteRow,
} from "../lib/private-notes";
import { parseFromIndex } from "../lib/shield-flow.js";
import { parseStealthStartBlock } from "../lib/stealth/scan.js";
import { readStealthStartBlock } from "../lib/stealth/start-block-file.js";
import {
  hasCachedStealthProfile,
  makeStealthAccountsStorage,
  type StealthWalletProfile,
} from "../lib/stealth/storage.js";
import { resolveRegisterSigner } from "../lib/names/ownership.js";
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
  withoutTor?: boolean;
  stealthStartBlock?: string;
  resyncProfile?: boolean;
  profileIndex?: string;
};

function stringifyBalancesJson(payload: unknown): string {
  return JSON.stringify(
    payload,
    (_key, value) => (typeof value === "bigint" ? value.toString() : value),
    2
  );
}

type WalletProfile = {
  /** Preferred name, or registrant address when no reverse name. */
  name: string;
  /** Human label for the balances header. */
  displayName: string;
  index?: number;
  account?: string;
  stealthMetaAddressURI?: string;
  /** Show “run init-profile …” under (none). */
  needsInit: boolean;
};

function profileDisplayName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "";
  if (isAddress(trimmed)) {
    return `${getAddress(trimmed)} (no name)`;
  }
  return trimmed;
}

function walletProfileFromCached(p: StealthWalletProfile): WalletProfile {
  return {
    name: p.name,
    displayName: profileDisplayName(p.name),
    index: p.index,
    account: p.address,
    stealthMetaAddressURI: p.stealthMetaAddressURI,
    needsInit: false,
  };
}

/**
 * Profile header for balances: prefer stealth-accounts `profile` cache;
 * otherwise onchain reverse (GNS→ENS→WNS) + stealth meta via resolver.
 */
async function resolveWalletProfile(opts: {
  rpcUrl: string;
  chainId: bigint;
  walletDir: string;
  mnemonic: string;
  password: string;
  resyncProfile: boolean;
  profileIndexFlag?: string;
}): Promise<WalletProfile> {
  const stealthStorage = makeStealthAccountsStorage(
    opts.walletDir,
    opts.password
  );
  const store = stealthStorage.getStore();

  if (!opts.resyncProfile && hasCachedStealthProfile(store)) {
    return walletProfileFromCached(store.profile);
  }

  let lookupIndex = 0;
  if (opts.profileIndexFlag !== undefined && opts.profileIndexFlag !== "") {
    const parsed = parseFromIndex(opts.profileIndexFlag);
    if (parsed === null) {
      throw new Error("--profile-index must be a non-negative integer.");
    }
    lookupIndex = parsed;
  } else if (hasCachedStealthProfile(store)) {
    lookupIndex = store.profile.index;
  }

  const empty = (): WalletProfile => {
    if (opts.resyncProfile) {
      stealthStorage.clearProfile();
    }
    return { name: "", displayName: "", needsInit: true };
  };

  let account: string;
  let index: number;
  try {
    const signer = resolveRegisterSigner({
      walletDir: opts.walletDir,
      mnemonic: opts.mnemonic,
      password: opts.password,
      indexFlag: String(lookupIndex),
      ownerPriv: true,
      dryRun: true,
    });
    account = signer.address;
    index = signer.index ?? lookupIndex;
  } catch {
    return empty();
  }

  const reversePriority = ["gns", "ens", "wns"] as const;
  let reverseName = "";
  try {
    const names = createEthereumNames({
      rpcUrl: opts.rpcUrl,
      reversePriority: [...reversePriority],
    });
    reverseName = (await names.reverse(account))?.trim() ?? "";
  } catch {
    reverseName = "";
  }

  try {
    if (reverseName) {
      const resolved = await resolveStealthMetaAddress({
        input: reverseName,
        rpcUrl: opts.rpcUrl,
        chainId: opts.chainId,
        reversePriority: [...reversePriority],
      });
      const profile: StealthWalletProfile = {
        name: reverseName,
        index,
        address: account,
        stealthMetaAddressURI: resolved.uri,
      };
      stealthStorage.setProfile(profile);
      return walletProfileFromCached(profile);
    }

    const resolved = await resolveStealthMetaAddress({
      input: account,
      rpcUrl: opts.rpcUrl,
      chainId: opts.chainId,
      reversePriority: [...reversePriority],
    });
    const profile: StealthWalletProfile = {
      name: account,
      index,
      address: account,
      stealthMetaAddressURI: resolved.uri,
    };
    stealthStorage.setProfile(profile);
    return walletProfileFromCached(profile);
  } catch {
    return empty();
  }
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
  profile: WalletProfile;
  publicAggregated: BalanceItem[];
  publicByAddress: Record<string, BalanceItem[]>;
  publicAccountIndexByAddress?: Record<string, number>;
  stealthAccountIndexByAddress?: Record<string, number>;
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
  console.log(
    chalk.dim("  wallet profile name: ") +
      (opts.profile.displayName
        ? chalk.cyan(opts.profile.displayName)
        : chalk.dim("(none)"))
  );
  if (opts.profile.needsInit) {
    console.log(
      chalk.yellow(
        "  run init-profile command to initialize your profile"
      )
    );
  }
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
      const hdIndex = opts.publicAccountIndexByAddress?.[addr];
      const stealthIndex = opts.stealthAccountIndexByAddress?.[addr];
      const label =
        stealthIndex !== undefined
          ? `[s${stealthIndex}]`
          : hdIndex !== undefined
            ? `[${hdIndex}]`
            : undefined;
      console.log();
      console.log(
        label !== undefined
          ? `  ${chalk.cyan.bold(label)} ${chalk.cyan.bold(addr)}`
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
    .option("--without-tor", cliOptions.withoutTor)
    .option("--stealth-start-block <block>", cliOptions.stealthStartBlock)
    .option(
      "--resync-profile",
      "Ignore cached stealth-accounts profile and re-resolve from chain (clears cache if nothing found)"
    )
    .option(
      "--profile-index <n>",
      "HD index to check for onchain profile discovery (default: cached index, else 0)"
    )
    .option("--dataDir <path>", cliOptions.dataDir)
    .action(async (opts: BalancesOpts) => {
      let stealthStartBlockFlag: bigint | undefined;
      if (opts.stealthStartBlock !== undefined) {
        try {
          stealthStartBlockFlag = parseStealthStartBlock(opts.stealthStartBlock);
        } catch (e) {
          cliErrorFromCaught(e);
          return;
        }
      }

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

      let stealthStartBlock = stealthStartBlockFlag;
      if (stealthStartBlock === undefined) {
        try {
          stealthStartBlock = readStealthStartBlock(walletDir) ?? undefined;
        } catch (e) {
          cliErrorFromCaught(e);
          return;
        }
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
              withoutTor: opts.withoutTor,
              stealthStartBlock,
              onTorStatus: (message) => {
                if (!quiet) loading.start(message);
              },
              onWarning: (msg) => {
                if (!quiet) {
                  log.warn(chalk.yellow(msg));
                }
              },
            });

            const profile = await resolveWalletProfile({
              rpcUrl,
              chainId: chainIdBn,
              walletDir,
              mnemonic,
              password,
              resyncProfile: !!opts.resyncProfile,
              profileIndexFlag: opts.profileIndex,
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
              wallet_profile_name: profile.displayName || null,
              wallet_profile: profile.stealthMetaAddressURI
                ? {
                    name: profile.name,
                    displayName: profile.displayName,
                    index: profile.index,
                    address: profile.account,
                    stealthMetaAddressURI: profile.stealthMetaAddressURI,
                  }
                : null,
              wallet_profile_needs_init: profile.needsInit,
              public_balances_aggregated: snap.publicAggregated,
              public_balances_by_address: snap.publicByAddress,
              private_balances: privateBalances,
            };

            if (opts.verbose) {
              const publicAccountIndexesOut: Record<string, number> = {};
              const stealthAccountIndexesOut: Record<string, number> = {};
              for (const addr of Object.keys(snap.publicByAddress)) {
                const idx = snap.publicAccountIndexByAddress[addr];
                if (idx !== undefined) {
                  publicAccountIndexesOut[addr] = idx;
                }
                const sIdx = snap.stealthAccountIndexByAddress[addr];
                if (sIdx !== undefined) {
                  stealthAccountIndexesOut[addr] = sIdx;
                }
              }
              payload.public_account_indexes_by_address = publicAccountIndexesOut;
              payload.stealth_account_indexes_by_address = stealthAccountIndexesOut;
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
                profile,
                publicAggregated: snap.publicAggregated,
                publicByAddress: snap.publicByAddress,
                publicAccountIndexByAddress: snap.publicAccountIndexByAddress,
                stealthAccountIndexByAddress: snap.stealthAccountIndexByAddress,
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
