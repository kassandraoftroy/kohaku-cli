import { existsSync } from "node:fs";
import { join } from "node:path";
import { intro, log, outro } from "@clack/prompts";
import { password } from "@inquirer/prompts";
import chalk from "chalk";
import type { Command } from "commander";

import {
  DEFAULT_DATA_DIR,
  walletNameToDirSegment,
} from "../utils/helpers";
import {
  generateMnemonic,
  normalizeValidatedMnemonic,
  writeSeedKeystore,
} from "../utils/mnemonic";

type CreateWalletOpts = {
  import?: boolean;
  nonInteractive?: boolean;
  password?: string;
  mnemonic?: string;
  dataDir?: string;
};

function printMnemonicBox(mnemonic: string): void {
  const line = mnemonic.trim();
  const inner = Math.max(line.length + 4, 44);
  const horiz = "─".repeat(inner);
  console.log();
  console.log(
    chalk.yellow.bold(
      "  ⚠  Write this down and store it offline. Anyone with these words can take your funds."
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

async function promptPasswordEncryptWallet(): Promise<string> {
  for (;;) {
    const pw = await password({
      message: "Password to encrypt this wallet:",
      mask: "*",
    });
    if (!pw?.trim()) {
      log.warn("Password cannot be empty.");
      continue;
    }
    const confirm = await password({
      message: "Confirm password:",
      mask: "*",
    });
    if (pw !== confirm) {
      log.warn("Passwords do not match. Try again.");
      continue;
    }
    return pw;
  }
}

export function registerCreateWalletCommand(program: Command): void {
  program
    .command("create-wallet <name>")
    .description("Create an encrypted wallet (BIP-39 seed on disk)")
    .option("--import", "Paste an existing mnemonic instead of generating one")
    .option("--non-interactive", "Run with no interactive prompts")
    .option("--password <password>", "Password to encrypt this wallet")
    .option("--mnemonic <phrase>", "Mnemonic phrase (required with --non-interactive --import)")
    .option("--dataDir <path>", "Kohaku data directory (default: ~/.kohaku-cli)")
    .action(async (name: string, opts: CreateWalletOpts) => {
      if (!opts.nonInteractive) {
        intro(chalk.bold("kohaku-cli — create wallet"));
      }

      const dataDir = opts.dataDir ?? DEFAULT_DATA_DIR;
      let walletDir: string;
      try {
        walletDir = join(dataDir, walletNameToDirSegment(name));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        log.error(chalk.red(`✖ ${msg}`));
        process.exitCode = 1;
        return;
      }

      if (existsSync(walletDir)) {
        console.error(chalk.red(`✖ A wallet named "${name}" already exists.`));
        process.exitCode = 1;
        return;
      }

      let mnemonicPhrase: string;
      if (opts.import) {
        const pasted = opts.nonInteractive
          ? opts.mnemonic
          : await password({
              message: "Enter your 12 or 24-word mnemonic:",
              mask: "*",
            });
        if (opts.nonInteractive && !pasted?.trim()) {
          log.error(chalk.red("✖ --mnemonic is required when using --non-interactive --import."));
          process.exitCode = 1;
          return;
        }
        try {
          mnemonicPhrase = normalizeValidatedMnemonic(pasted ?? "");
        } catch (e) {
          const msg = e instanceof Error ? e.message : "Invalid mnemonic";
          log.error(chalk.red(`✖ ${msg}`));
          process.exitCode = 1;
          return;
        }
      } else {
        mnemonicPhrase = generateMnemonic();
        if (!opts.nonInteractive) {
          printMnemonicBox(mnemonicPhrase);
        }
      }

      let encryptPassword: string;
      if (opts.nonInteractive) {
        if (!opts.password?.trim()) {
          log.error(chalk.red("✖ --password is required when using --non-interactive."));
          process.exitCode = 1;
          return;
        }
        encryptPassword = opts.password;
      } else {
        encryptPassword = await promptPasswordEncryptWallet();
      }

      try {
        writeSeedKeystore(mnemonicPhrase, encryptPassword, walletDir);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        log.error(chalk.red(`✖ ${msg}`));
        process.exitCode = 1;
        return;
      }

      if (!opts.nonInteractive) {
        outro(chalk.green(`✔ Wallet "${name}" created and saved.`));
        return;
      }
      console.log(chalk.green(`✔ Wallet "${name}" created and saved.`));
    });
}
