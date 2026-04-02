import { join } from "node:path";
import { log } from "@clack/prompts";
import chalk from "chalk";
import type { Command } from "commander";

import { makePublicAccountsStorage } from "../utils/public-accounts";
import { DEFAULT_DATA_DIR, walletNameToDirSegment } from "../utils/helpers";
import { readSeedKeystore } from "../utils/mnemonic";

type NextFreshAddressOpts = {
  wallet?: string;
  password?: string;
  dataDir?: string;
};

export function registerNextFreshAddressCommand(program: Command): void {
  program
    .command("next-fresh-address")
    .description("Generate and persist the next public account address")
    .option("--wallet <name>", "Wallet name", "default")
    .requiredOption("--password <password>", "Wallet password")
    .option("--dataDir <path>", "Kohaku data directory (default: ~/.kohaku-cli)")
    .action(async (opts: NextFreshAddressOpts) => {
      const walletName = opts.wallet ?? "default";
      const password = opts.password ?? "";
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
      const account = storage.generateNextIndex();
      console.log(account.address);
    });
}
