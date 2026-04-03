import { join } from "node:path";
import { log } from "@clack/prompts";
import chalk from "chalk";
import type { Command } from "commander";

import { makePublicAccountsStorage } from "../utils/public-accounts";
import { DEFAULT_DATA_DIR, walletNameToDirSegment } from "../utils/helpers";
import { readSeedKeystore } from "../utils/mnemonic";
import { resolveWalletPassword } from "../utils/wallet-password";

type NextFreshAddressOpts = {
  wallet?: string;
  password?: string;
  nonInteractive?: boolean;
  dataDir?: string;
};

export function registerNextFreshAddressCommand(program: Command): void {
  program
    .command("next-fresh-address")
    .description("Generate and persist the next public account address")
    .option("--wallet <name>", "Wallet name", "default")
    .option("--password <password>", "Wallet password (required with --non-interactive; else prompted)")
    .option("--non-interactive", "No prompts (requires --password)")
    .option("--dataDir <path>", "Kohaku data directory (default: ~/.kohaku-cli)")
    .action(async (opts: NextFreshAddressOpts) => {
      const walletName = opts.wallet ?? "default";
      const dataDir = opts.dataDir ?? DEFAULT_DATA_DIR;

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

      const storage = makePublicAccountsStorage(walletDir, mnemonic, password);
      const added = storage.addNextAccounts(1);
      console.log(added[0]!.address);
    });
}
