import { join } from "node:path";
import { log, spinner } from "@clack/prompts";
import chalk from "chalk";
import type { Command } from "commander";
import { Contract, formatUnits, getAddress, isAddress } from "ethers";

import { readWalletType } from "../utils/wallet-type";
import { makeEthersProvider } from "../utils/eth-provider";
import {
  DEFAULT_DATA_DIR,
  resolveRpcUrl,
  walletNameToDirSegment,
} from "../utils/helpers";
import { resolveWalletNameOrPrompt } from "../utils/wallets";
import { readSeedKeystore } from "../utils/mnemonic";
import { makePublicAccountsStorage } from "../utils/public-accounts";
import { resolveWalletPassword } from "../utils/wallet-password";

const ERC20_ABI = [
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];

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

function printAggregatedTotalsTable(aggregated: BalanceItem[]): void {
  console.log(chalk.bold("  ■ Totals (all public accounts)"));
  console.log(chalk.dim(`  ${THIN}`));
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

function printHumanPublicBalances(opts: {
  walletName: string;
  chainId: string;
  aggregated: BalanceItem[];
  byAddress: Record<string, BalanceItem[]>;
  verbose: boolean;
}): void {
  console.log();
  console.log(chalk.bold(` ${BAR}`));
  console.log(
    chalk.bold("  Public balances"),
    chalk.dim("·"),
    chalk.cyan(opts.walletName),
    chalk.dim(`· chain ${opts.chainId}`)
  );
  console.log(chalk.bold(` ${BAR}`));
  console.log();

  printAggregatedTotalsTable(opts.aggregated);

  if (opts.verbose) {
    console.log();
    console.log(chalk.bold("  ■ By address"));
    console.log(chalk.dim(`  ${THIN}`));

    const addrs = Object.keys(opts.byAddress);
    if (addrs.length === 0) {
      console.log(chalk.dim("  (no public accounts)"));
    }

    for (const addr of addrs) {
      const rows = opts.byAddress[addr];
      if (!rows) continue;
      console.log();
      console.log(`  ${chalk.cyan.bold(addr)}`);
      console.log(chalk.dim(`  ${THIN}`));
      const w = columnWidths(rows);
      console.log(
        chalk.dim(
          `  ${padCell("Symbol", w.symW)}  ${padCell("Balance", w.amtW)}  Token`
        )
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

    console.log();
    printAggregatedTotalsTable(opts.aggregated);
  }

  console.log();
  console.log(chalk.bold(` ${BAR}`));
  console.log();
}

export function registerBalancesCommand(program: Command): void {
  program
    .command("balances")
    .description("Print public account balances (ETH + optional ERC20s from --tokensList)")
    .option(
      "--wallet <name>",
      "Wallet name (optional without --non-interactive; omit to pick from the list)"
    )
    .option("--password <password>", "Wallet password (required with --non-interactive; else prompted)")
    .option(
      "--non-interactive",
      "Agent mode: JSON only, no prompts; requires --password and --wallet"
    )
    .option(
      "--verbose",
      "With human-readable output, also show per-account breakdown (ignored with --non-interactive)"
    )
    .option("--rpc-url <url>", "RPC URL (or set RPC_URL)")
    .option(
      "--tokensList <addrs>",
      "Comma- or space-separated ERC20 addresses to fetch for every public account"
    )
    .option("--dataDir <path>", "Kohaku data directory (default: ~/.kohaku-cli)")
    .action(async (opts: BalancesOpts) => {
      const dataDir = opts.dataDir ?? DEFAULT_DATA_DIR;
      const walletName = await resolveWalletNameOrPrompt({
        dataDir,
        wallet: opts.wallet,
        nonInteractive: opts.nonInteractive,
      });
      if (!walletName) {
        process.exitCode = 1;
        return;
      }
      const rpcUrl = resolveRpcUrl(opts.rpcUrl);
      if (!rpcUrl) {
        log.error(chalk.red("✖ Missing --rpc-url (or environment variable RPC_URL)."));
        process.exitCode = 1;
        return;
      }

      let walletDir: string;
      try {
        walletDir = join(dataDir, walletNameToDirSegment(walletName));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        log.error(chalk.red(`✖ ${msg}`));
        process.exitCode = 1;
        return;
      }

      const password = await resolveWalletPassword({
        flagPassword: opts.password,
        nonInteractive: opts.nonInteractive,
      });
      if (!password) {
        process.exitCode = 1;
        return;
      }

      let mnemonic: string;
      try {
        mnemonic = readSeedKeystore(password, walletDir);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        log.error(chalk.red(`✖ ${msg}`));
        process.exitCode = 1;
        return;
      }

      const chainIdString = readWalletType(walletDir) === "testnet" ? "11155111" : "1";
      const rpc = await makeEthersProvider(rpcUrl);
      let rpcChainId: bigint;
      try {
        const network = await rpc.getNetwork();
        rpcChainId = network.chainId;
      } finally {
        rpc.destroy();
      }
      if (rpcChainId.toString() !== chainIdString) {
        log.error(
          chalk.red(
            `✖ RPC chainId ${rpcChainId.toString()} does not match wallet chainId ${chainIdString}.`
          )
        );
        process.exitCode = 1;
        return;
      }

      let tokenAddresses: `0x${string}`[];
      try {
        tokenAddresses = parseTokensList(opts.tokensList);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        log.error(chalk.red(`✖ ${msg}`));
        process.exitCode = 1;
        return;
      }

      const loading = spinner();
      loading.start("Loading public balances...");
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
        try {
          for (const token of tokenAddresses) {
            tokenMeta.set(token.toLowerCase(), await loadErc20Meta(rpcForPublic, token));
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

        const payload = {
          public_balances_aggregated: publicBalancesAggregated,
          public_balances_by_address: publicByAddress,
        };

        if (opts.nonInteractive) {
          console.log(stringifyBalancesJson(payload));
        } else {
          printHumanPublicBalances({
            walletName,
            chainId: chainIdString,
            aggregated: publicBalancesAggregated,
            byAddress: publicByAddress,
            verbose: !!opts.verbose,
          });
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        loading.stop("Balances failed.", 1);
        log.error(chalk.red(`✖ ${msg}`));
        process.exitCode = 1;
      }
    });
}
