import { existsSync } from "node:fs";
import { intro, log, outro } from "@clack/prompts";
import { password } from "@inquirer/prompts";
import chalk from "chalk";
import type { Command } from "commander";

import { cliOptions } from "../utils/cli-command-options";
import { cliError, cliErrorFromCaught } from "../utils/cli-errors";
import {
  createWalletOnDisk,
  generateMnemonic,
  interpretImportStealthStartBlockFlag,
} from "../lib/create-wallet";
import {
  DEFAULT_DATA_DIR,
  resolveOptionalRpcUrl,
  resolveRpcUrl,
} from "../utils/rpc";
import {
  resolvePasswordInputPreferFile,
  resolveWalletDir,
} from "../utils/wallets-util";
import { normalizeValidatedMnemonic } from "../utils/mnemonic";

type CreateWalletOpts = {
  import?: boolean;
  nonInteractive?: boolean;
  password?: string;
  mnemonic?: string;
  rpcUrl?: string;
  testnet?: boolean;
  longSeed?: boolean;
  stealthStartBlock?: string | true;
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
    .description("Create a kohaku-cli wallet (BIP-39 seed ecrypted on disk)")
    .option("--import", "Paste an existing mnemonic instead of generating one")
    .option(
      "--non-interactive",
      "Agent mode: no interactive prompts (requires --password and other flags as documented)"
    )
    .option(
      "--password <password>",
      "Password to encrypt this wallet (required with --non-interactive; else prompted)"
    )
    .option("--mnemonic <phrase>", "Mnemonic phrase (required with --non-interactive --import)")
    .option("--rpc-url <url>", "RPC URL (or set RPC_URL). Optional for new wallets: a public RPC is used to record the current block if unset. Required with --import")
    .option("--testnet", "Use testnet chain ID (11155111) instead of mainnet (1)")
    .option(
      "--stealth-start-block [block]",
      "With --import: write `.stealth-start-block`. Bare flag = Kohaku floor (mainnet 25700000, Sepolia 11455454). With a number, use that block (rounded up to the ERC-5564 announcer deploy if lower). Omit the flag to record the current tip (same as a new wallet)."
    )
    .option(
      "--long-seed",
      "Generate a 24-word (256-bit) mnemonic instead of the default 12-word (128-bit)"
    )
    .option("--dataDir <path>", cliOptions.dataDir)
    .action(async (name: string, opts: CreateWalletOpts) => {
      if (!opts.nonInteractive) {
        intro(chalk.bold("kohaku-cli — create wallet"));
      }

      if (opts.import && opts.longSeed) {
        cliError("--long-seed only applies when generating a new mnemonic (omit --import).");
        return;
      }

      const dataDir = opts.dataDir ?? DEFAULT_DATA_DIR;
      let walletDir: string;
      try {
        walletDir = resolveWalletDir(dataDir, name);
      } catch (e) {
        cliErrorFromCaught(e);
        return;
      }

      if (existsSync(walletDir)) {
        cliError(`A wallet named "${name}" already exists.`);
        return;
      }

      let mnemonicPhrase: string;
      let importRpcUrl: string | undefined;
      if (opts.import) {
        const pasted = opts.nonInteractive
          ? opts.mnemonic
          : await password({
              message: "Enter your 12 or 24-word mnemonic:",
              mask: "*",
            });
        if (opts.nonInteractive && !pasted?.trim()) {
          cliError("--mnemonic is required when using --non-interactive --import.");
          return;
        }
        importRpcUrl = resolveRpcUrl(opts.rpcUrl);
        try {
          mnemonicPhrase = normalizeValidatedMnemonic(pasted ?? "");
        } catch (e) {
          const msg = e instanceof Error ? e.message : "Invalid mnemonic";
          cliError(msg);
          return;
        }
      } else {
        mnemonicPhrase = generateMnemonic(opts.longSeed ? 256 : 128);
        if (!opts.nonInteractive) {
          printMnemonicBox(mnemonicPhrase);
        }
      }

      let encryptPassword: string;
      if (opts.nonInteractive) {
        const resolved = resolvePasswordInputPreferFile(opts.password);
        if (!resolved) {
          cliError("--password is required when using --non-interactive.");
          return;
        }
        encryptPassword = resolved;
      } else {
        encryptPassword = await promptPasswordEncryptWallet();
      }

      if (opts.stealthStartBlock !== undefined && !opts.import) {
        cliError(
          "--stealth-start-block only applies with --import (new wallets record the current block automatically)."
        );
        return;
      }

      let stealthStartBlock: bigint | undefined;
      if (opts.stealthStartBlock !== undefined) {
        try {
          stealthStartBlock = interpretImportStealthStartBlockFlag(
            opts.stealthStartBlock,
            opts.testnet ? 11155111n : 1n
          );
        } catch (e) {
          cliErrorFromCaught(e);
          return;
        }
      }

      // New wallets: only use an RPC the user set; otherwise public endpoints (not localhost).
      const preferredRpcUrl = opts.import
        ? importRpcUrl
        : resolveOptionalRpcUrl(opts.rpcUrl);

      try {
        const created = await createWalletOnDisk({
          dataDir,
          walletName: name,
          mnemonic: mnemonicPhrase,
          password: encryptPassword,
          testnet: !!opts.testnet,
          importMode: !!opts.import,
          rpcUrl: preferredRpcUrl,
          stealthStartBlock,
        });
        if (
          !opts.nonInteractive &&
          created.stealthStartBlockWritten !== undefined
        ) {
          log.info(
            `Stealth announcement scan floor: block ${created.stealthStartBlockWritten.toString()} (saved in .stealth-start-block).`
          );
        }
      } catch (e) {
        cliErrorFromCaught(e);
        return;
      }

      if (!opts.nonInteractive) {
        outro(chalk.green(`✔ Wallet "${name}" created and saved.`));
        return;
      }
      console.log(chalk.green(`✔ Wallet "${name}" created and saved.`));
    });
}
