import { existsSync } from "node:fs";
import { intro, log, outro } from "@clack/prompts";
import { password } from "@inquirer/prompts";
import chalk from "chalk";
import type { Command } from "commander";

import { cliOptions } from "../utils/cli-command-options";
import { cliError, cliErrorFromCaught } from "../utils/cli-errors";
import { makePublicAccountsStorage } from "../utils/public-accounts";
import { isAddressUsed } from "../utils/address-used";
import {
  DEFAULT_DATA_DIR,
  makeEthersProvider,
  resolveRpcUrl,
} from "../utils/rpc";
import {
  resolvePasswordInputPreferFile,
  resolveWalletDir,
  writeWalletType,
} from "../utils/wallets-util";
import {
  generateMnemonic,
  normalizeValidatedMnemonic,
  peekAddressesFromMnemonic,
  writeSeedKeystore,
} from "../utils/mnemonic";

type CreateWalletOpts = {
  import?: boolean;
  nonInteractive?: boolean;
  password?: string;
  mnemonic?: string;
  rpcUrl?: string;
  testnet?: boolean;
  dataDir?: string;
};

async function findLastTouchedIndex(
  mnemonic: string,
  rpcUrl: string,
): Promise<number> {
  const provider = await makeEthersProvider(rpcUrl);
  try {
    let start = 0;
    let lastTouched = -1;
    const WINDOW_SIZE = 10;

    for (;;) {
      const indexes = Array.from(
        { length: WINDOW_SIZE },
        (_, i) => start + i
      );
      const addresses: string[] = peekAddressesFromMnemonic(mnemonic, indexes);
      const touched = await Promise.all(
        addresses.map(async (address: string) => {
          return isAddressUsed(address, provider);
        })
      );

      for (let i = 0; i < touched.length; i += 1) {
        if (touched[i]) {
          lastTouched = indexes[i]!;
        }
      }

      if (!touched.some(Boolean)) {
        return lastTouched;
      }
      start += WINDOW_SIZE;
    }
  } finally {
    provider.destroy();
  }
}

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
    .option("--rpc-url <url>", "RPC URL (required with --import; or set RPC_URL)")
    .option("--testnet", "Use testnet chain ID (11155111) instead of mainnet (1)")
    .option("--dataDir <path>", cliOptions.dataDir)
    .action(async (name: string, opts: CreateWalletOpts) => {
      if (!opts.nonInteractive) {
        intro(chalk.bold("kohaku-cli — create wallet"));
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
      let rpcUrl: string | undefined;
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
        rpcUrl = resolveRpcUrl(opts.rpcUrl);
        if (!rpcUrl) {
          cliError(
            "Missing --rpc-url (or environment variable RPC_URL) when using --import."
          );
          return;
        }
        try {
          mnemonicPhrase = normalizeValidatedMnemonic(pasted ?? "");
        } catch (e) {
          const msg = e instanceof Error ? e.message : "Invalid mnemonic";
          cliError(msg);
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
        const resolved = resolvePasswordInputPreferFile(opts.password);
        if (!resolved) {
          cliError("--password is required when using --non-interactive.");
          return;
        }
        encryptPassword = resolved;
      } else {
        encryptPassword = await promptPasswordEncryptWallet();
      }

      const chainIdString = opts.testnet ? "11155111" : "1";
      const expectedChainId = opts.testnet ? 11155111n : 1n;

      let lastTouchedIndex = -1;
      if (opts.import && rpcUrl) {
        const provider = await makeEthersProvider(rpcUrl);
        try {
          const network = await provider.getNetwork();
          if (network.chainId !== expectedChainId) {
            cliError(
              `RPC chain ID ${network.chainId.toString()} does not match expected ${expectedChainId.toString()} for this wallet.`
            );
            return;
          }
        } finally {
          provider.destroy();
        }
        lastTouchedIndex = await findLastTouchedIndex(mnemonicPhrase, rpcUrl);
      }

      try {
        writeSeedKeystore(mnemonicPhrase, encryptPassword, walletDir);
        const walletType = opts.testnet ? "testnet" : "mainnet";
        writeWalletType(walletType, walletDir);
        if (opts.import && lastTouchedIndex >= 0) {
          const publicAccountsStorage = makePublicAccountsStorage(
            walletDir,
            mnemonicPhrase,
            encryptPassword
          );
          publicAccountsStorage.addNextAccounts(lastTouchedIndex + 1);
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
