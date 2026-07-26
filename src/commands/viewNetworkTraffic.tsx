import React from "react";
import { render } from "ink";
import chalk from "chalk";
import type { Command } from "commander";

import {
  NetworkTrafficViewer,
  summarizeNetworkTraffic,
} from "./NetworkTrafficViewer.js";
import { cliOptions } from "../utils/cli-command-options.js";
import { cliError, cliErrorFromCaught } from "../utils/cli-errors.js";
import { logCliJson } from "../utils/cli-quiet.js";
import {
  clearNetworkTrafficLog,
  formatTrafficEntryLine,
  networkTrafficLogPath,
  readNetworkTrafficLog,
  type NetworkTrafficEntry,
} from "../utils/network-traffic-log.js";
import { DEFAULT_DATA_DIR } from "../utils/rpc.js";
import {
  resolveWalletDir,
  resolveWalletNameOrPrompt,
} from "../utils/wallets-util.js";

type ViewNetworkTrafficOpts = {
  wallet?: string;
  dataDir?: string;
  nonInteractive?: boolean;
  json?: boolean;
  clear?: boolean;
  torOnly?: boolean;
  clearnetOnly?: boolean;
  limit?: string;
  category?: string;
};

function filterEntries(
  entries: NetworkTrafficEntry[],
  opts: {
    torOnly?: boolean;
    clearnetOnly?: boolean;
    category?: string;
    limit?: number;
  }
): NetworkTrafficEntry[] {
  let out = entries;
  if (opts.torOnly) out = out.filter((e) => e.via === "tor");
  if (opts.clearnetOnly) out = out.filter((e) => e.via === "clearnet");
  if (opts.category) {
    const cat = opts.category.trim().toLowerCase();
    out = out.filter((e) => e.category === cat);
  }
  if (opts.limit != null && opts.limit > 0 && out.length > opts.limit) {
    out = out.slice(out.length - opts.limit);
  }
  return out;
}

export function registerViewNetworkTrafficCommand(program: Command): void {
  program
    .command("view-network-traffic")
    .description(
      "Browse this wallet's logged network traffic (Tor vs clearnet) for anonymity review"
    )
    .option("--wallet <name>", cliOptions.walletPickList)
    .option("--dataDir <path>", cliOptions.dataDir)
    .option(
      "--non-interactive",
      "Print the log to stdout (no pager); with --json print JSON"
    )
    .option("--json", "Print entries as a JSON array (implies non-interactive)")
    .option("--clear", "Delete the traffic log for this wallet and exit")
    .option("--tor-only", "Show only Tor-routed requests")
    .option("--clearnet-only", "Show only clearnet requests")
    .option("--limit <n>", "Show at most the last N entries")
    .option(
      "--category <name>",
      "Filter by category: pimlico|subsquid|ppoi|saga|asp|fastrelay|artifacts|rpc|other"
    )
    .action(async (opts: ViewNetworkTrafficOpts) => {
      if (opts.torOnly && opts.clearnetOnly) {
        cliError("Use only one of --tor-only or --clearnet-only.");
        return;
      }

      const dataDir = opts.dataDir ?? DEFAULT_DATA_DIR;
      const walletName = await resolveWalletNameOrPrompt({
        dataDir,
        wallet: opts.wallet,
        nonInteractive: !!(opts.nonInteractive || opts.json),
      });
      if (!walletName) return;

      let walletDir: string;
      try {
        walletDir = resolveWalletDir(dataDir, walletName);
      } catch (e) {
        cliErrorFromCaught(e);
        return;
      }

      const logPath = networkTrafficLogPath(walletDir);

      if (opts.clear) {
        const removed = clearNetworkTrafficLog(walletDir);
        if (opts.json || opts.nonInteractive) {
          logCliJson({ cleared: removed, path: logPath });
        } else {
          console.log(
            removed
              ? chalk.green(`Cleared traffic log: ${logPath}`)
              : chalk.dim(`No traffic log to clear (${logPath})`)
          );
        }
        return;
      }

      let limit: number | undefined;
      if (opts.limit != null) {
        const n = Number(opts.limit);
        if (!Number.isInteger(n) || n <= 0) {
          cliError("--limit must be a positive integer.");
          return;
        }
        limit = n;
      }

      const all = readNetworkTrafficLog(walletDir);
      const entries = filterEntries(all, {
        torOnly: opts.torOnly,
        clearnetOnly: opts.clearnetOnly,
        category: opts.category,
        limit,
      });
      const summary = summarizeNetworkTraffic(entries);

      if (opts.json) {
        logCliJson({
          wallet: walletName,
          path: logPath,
          summary,
          entries,
        });
        return;
      }

      if (opts.nonInteractive || !process.stdout.isTTY) {
        console.log(chalk.bold(`Network traffic · ${walletName}`));
        console.log(chalk.dim(logPath));
        console.log(
          `${summary.total} events · ${chalk.green(`${summary.tor} tor`)} · ${chalk.yellow(`${summary.clearnet} clearnet`)}`
        );
        console.log(chalk.dim("─".repeat(72)));
        if (entries.length === 0) {
          console.log(
            chalk.dim(
              "No traffic logged yet. Run balances / shield / unshield / transfer first."
            )
          );
          return;
        }
        for (const e of entries) {
          const line = formatTrafficEntryLine(e);
          if (e.via === "tor") console.log(chalk.green(line));
          else if (e.ok === false || e.error) console.log(chalk.red(line));
          else console.log(chalk.yellow(line));
        }
        return;
      }

      const instance = render(
        <NetworkTrafficViewer
          walletName={walletName}
          logPath={logPath}
          entries={entries}
        />
      );
      await instance.waitUntilExit();
    });
}
