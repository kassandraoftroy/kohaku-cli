import { existsSync } from "node:fs";
import { join } from "node:path";
import { intro, log, outro } from "@clack/prompts";
import { password } from "@inquirer/prompts";
import chalk from "chalk";
import type { Command } from "commander";

import { makePublicAccountsStorage } from "../utils/public-accounts";
import {
  DEFAULT_DATA_DIR,
  isAddressUsed,
  resolveRpcUrl,
  walletNameToDirSegment,
} from "../utils/helpers";
import {
  generateMnemonic,
  normalizeValidatedMnemonic,
  peekAddressesFromMnemonic,
  writeSeedKeystore,
} from "../utils/mnemonic";
import { writeWalletType } from "../utils/wallet-type";
import { makeEthersProvider } from "../utils/eth-provider";

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
      let rpcUrl: string | undefined;
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
        rpcUrl = resolveRpcUrl(opts.rpcUrl);
        if (!rpcUrl) {
          log.error(
            chalk.red(
              "✖ Missing --rpc-url (or environment variable RPC_URL) when using --import."
            )
          );
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

      const chainIdString = opts.testnet ? "11155111" : "1";
      const expectedChainId = opts.testnet ? 11155111n : 1n;

      let lastTouchedIndex = -1;
      if (opts.import && rpcUrl) {
        const provider = await makeEthersProvider(rpcUrl);
        try {
          const network = await provider.getNetwork();
          if (network.chainId !== expectedChainId) {
            log.error(
              chalk.red(
                `✖ RPC chain ID ${network.chainId.toString()} does not match expected ${expectedChainId.toString()} for this wallet.`
              )
            );
            process.exitCode = 1;
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
