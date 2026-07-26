import { confirm } from "@inquirer/prompts";
import chalk from "chalk";
import type { Command } from "commander";

import { readSeedKeystore } from "../utils/mnemonic";
import { DEFAULT_DATA_DIR } from "../utils/rpc";
import { cliOptions } from "../utils/cli-command-options";
import { cliError, cliErrorFromCaught } from "../utils/cli-errors";
import {
  resolveWalletDir,
  resolveWalletNameOrPrompt,
  resolveWalletPassword,
} from "../utils/wallets-util";

type RevealSeedPhraseOpts = {
  wallet?: string;
  password?: string;
  nonInteractive?: boolean;
  dataDir?: string;
};

function printMnemonicBox(mnemonic: string): void {
  const line = mnemonic.trim();
  const inner = Math.max(line.length + 4, 44);
  const horiz = "─".repeat(inner);
  console.log();
  console.log(
    chalk.yellow.bold(
      "  ⚠  Anyone with these words can take your funds. Store them offline and clear your terminal scrollback."
    )
  );
  console.log();
  console.log(chalk.cyan(`  ┌${horiz}┐`));
  const pad = inner - line.length;
  const left = Math.floor(pad / 2);
  const right = pad - left;
  console.log(
    chalk.cyan("  │") +
      " ".repeat(left) +
      chalk.bold.white(line) +
      " ".repeat(right) +
      chalk.cyan("│")
  );
  console.log(chalk.cyan(`  └${horiz}┘`));
  console.log();
}

export function registerRevealSeedPhraseCommand(program: Command): void {
  program
    .command("reveal-seed-phrase")
    .description("Decrypt and print the wallet BIP-39 seed phrase")
    .option("--wallet <name>", cliOptions.walletPickList)
    .option("--password <password>", cliOptions.password)
    .option("--non-interactive", cliOptions.nonInteractiveCompact)
    .option("--dataDir <path>", cliOptions.dataDir)
    .action(async (opts: RevealSeedPhraseOpts) => {
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

      if (!opts.nonInteractive) {
        const first = await confirm({
          message: `Reveal the seed phrase for wallet "${walletName}"? Anyone with these words can take your funds.`,
          default: false,
        });
        if (!first) {
          cliError("Cancelled by user.");
          return;
        }
        const second = await confirm({
          message:
            "Confirm again: print the full seed phrase to this terminal now?",
          default: false,
        });
        if (!second) {
          cliError("Cancelled by user.");
          return;
        }
        printMnemonicBox(mnemonic);
      } else {
        console.log(mnemonic);
      }
    });
}
