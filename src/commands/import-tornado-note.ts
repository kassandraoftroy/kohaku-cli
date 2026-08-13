import { log, spinner } from "@clack/prompts";
import chalk from "chalk";
import type { Command } from "commander";
import type { ImportNoteResult } from "@kohaku-eth/tornado-cash";

import { withProtocolRuntime } from "../lib/protocol-runtime.js";
import { cliOptions } from "../utils/cli-command-options";
import { cliError, cliErrorFromCaught } from "../utils/cli-errors";
import {
  logCliJson,
  manageSpinner,
  quietNonInteractive,
  runQuietSpinner,
} from "../utils/cli-quiet";
import { readSeedKeystore } from "../utils/mnemonic";
import {
  DEFAULT_DATA_DIR,
  getRpcChainIdMatchingWallet,
  resolveRpcUrl,
} from "../utils/rpc";
import { withTor } from "../utils/tor.js";
import {
  resolveWalletDir,
  resolveWalletNameOrPrompt,
  resolveWalletPassword,
} from "../utils/wallets-util";

type ImportTornadoNoteOpts = {
  wallet?: string;
  password?: string;
  rpcUrl?: string;
  nonInteractive?: boolean;
  withoutTor?: boolean;
  dataDir?: string;
};

function redactNote(note: string): string {
  const trimmed = note.trim();
  if (trimmed.length <= 28) return trimmed;
  return `${trimmed.slice(0, 20)}…${trimmed.slice(-8)}`;
}

/**
 * Accept classic `tornado-<currency>-…` notes and the shorter
 * `<currency>-…` form (prefix is redundant on this command).
 */
export function normalizeTornadoNoteInput(note: string): string {
  const trimmed = note.trim();
  if (!trimmed) return trimmed;
  if (/^tornado-/i.test(trimmed)) return trimmed;
  return `tornado-${trimmed}`;
}

function printResults(results: ImportNoteResult[]): void {
  for (const result of results) {
    if (result.status === "imported") {
      console.log(
        chalk.green("imported") +
          `  ${redactNote(result.note)}  pool=${result.poolAddress}`
      );
    } else if (result.status === "wrong-chain") {
      console.log(
        chalk.yellow("wrong-chain") + `  ${redactNote(result.note)}`
      );
    } else {
      console.log(chalk.red("not-found") + `  ${redactNote(result.note)}`);
    }
  }
}

export function registerImportTornadoNoteCommand(program: Command): void {
  program
    .command("import-tornado-note")
    .description(
      "Import legacy Tornado Cash note string(s) into this wallet (non-mnemonic deposits)"
    )
    .argument(
      "<notes...>",
      "Note string(s): <currency>-<denom>-<chainId>-0x… (optional tornado- prefix)"
    )
    .option("--wallet <name>", cliOptions.walletPickList)
    .option("--password <password>", cliOptions.password)
    .option("--rpc-url <url>", cliOptions.rpcUrl)
    .option("--non-interactive", cliOptions.nonInteractiveCompact)
    .option("--without-tor", cliOptions.withoutTor)
    .option("--dataDir <path>", cliOptions.dataDir)
    .action(async (notesArg: string[], opts: ImportTornadoNoteOpts) => {
      const notes = notesArg
        .map((n) => normalizeTornadoNoteInput(n))
        .filter(Boolean);
      if (notes.length === 0) {
        cliError("Provide at least one Tornado Cash note string.");
        return;
      }

      const rpcUrl = resolveRpcUrl(opts.rpcUrl);

      const dataDir = opts.dataDir ?? DEFAULT_DATA_DIR;
      const walletName = await resolveWalletNameOrPrompt({
        dataDir,
        wallet: opts.wallet,
        nonInteractive: opts.nonInteractive,
      });
      if (!walletName) return;

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

      let chainId: bigint;
      try {
        chainId = await getRpcChainIdMatchingWallet(rpcUrl, walletDir);
      } catch (e) {
        cliErrorFromCaught(e);
        return;
      }

      const quiet = quietNonInteractive(opts.nonInteractive);
      const spin = manageSpinner(spinner(), quiet);
      const useTor = !opts.withoutTor;

      try {
        await withTor(
          useTor,
          {
            rpcUrl,
            walletDir,
            onStatus: (message) => {
              spin.start(message);
            },
          },
          async () => {
            if (spin.active) spin.stop("Tor ready.");

            const results = await runQuietSpinner(
              quiet,
              spin,
              {
                start: "Syncing Tornado Cash and importing note(s)",
                failure: "Import failed.",
              },
              () =>
                withProtocolRuntime(
                  {
                    protocol: "tornado",
                    rpcUrl,
                    walletDir,
                    password,
                    mnemonic,
                    chainId,
                  },
                  async (_host, plugin) => {
                    if (!plugin.importNotes) {
                      throw new Error(
                        "Tornado plugin does not expose importNotes (upgrade @kohaku-eth/tornado-cash)."
                      );
                    }
                    return (await plugin.importNotes(notes)) as ImportNoteResult[];
                  }
                ),
              (imported) => {
                const ok = imported.filter((r) => r.status === "imported").length;
                return `Import finished: ${ok}/${imported.length} note(s) registered.`;
              }
            );

            if (quiet) {
              logCliJson({
                chainId: chainId.toString(),
                results: results.map((r) =>
                  r.status === "imported"
                    ? {
                        note: r.note,
                        status: r.status,
                        poolAddress: r.poolAddress,
                      }
                    : { note: r.note, status: r.status }
                ),
              });
            } else {
              printResults(results);
              const imported = results.filter((r) => r.status === "imported");
              if (imported.length > 0) {
                log.success(
                  `${imported.length} note(s) imported. They appear in \`balances\` and can be spent with \`unshield --protocol tornado\`.`
                );
              }
              const failed = results.length - imported.length;
              if (failed > 0) {
                log.warn(
                  `${failed} note(s) were not imported (wrong-chain or not found on synced deposits).`
                );
              }
            }

            if (!results.some((r) => r.status === "imported")) {
              process.exitCode = 1;
            }
          }
        );
      } catch (e) {
        cliErrorFromCaught(e);
      } finally {
        if (spin.active) spin.stop();
      }
    });
}
