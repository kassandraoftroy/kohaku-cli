import type { Command } from "commander";

import { cliOptions } from "../utils/cli-command-options";
import { cliErrorFromCaught } from "../utils/cli-errors";
import { makePublicAccountsStorage } from "../utils/public-accounts";
import { DEFAULT_DATA_DIR } from "../utils/rpc";
import {
  resolveWalletDir,
  resolveWalletNameOrPrompt,
  resolveWalletPassword,
} from "../utils/wallets-util";
import { readSeedKeystore } from "../utils/mnemonic";

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
    .option("--wallet <name>", cliOptions.walletPickList)
    .option("--password <password>", cliOptions.password)
    .option("--non-interactive", cliOptions.nonInteractiveCompact)
    .option("--dataDir <path>", cliOptions.dataDir)
    .action(async (opts: NextFreshAddressOpts) => {
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

      const storage = makePublicAccountsStorage(walletDir, mnemonic, password);
      const added = storage.addNextAccounts(1);
      console.log(added[0]!.address);
    });
}
