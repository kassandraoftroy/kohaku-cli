import type { Command } from "commander";

import { cliOptions, passwordFileOption } from "../utils/cli-command-options";
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
  passwordFile?: string;
  peek?: boolean;
  nonInteractive?: boolean;
  dataDir?: string;
};

export function registerNextFreshAddressCommand(program: Command): void {
  program
    .command("next-fresh-address")
    .description("Generate and persist the next public account address")
    .option("--wallet <name>", cliOptions.walletPickList)
    .option("--password <password>", cliOptions.password)
    .addOption(passwordFileOption())
    .option(
      "--peek",
      "Print the next fresh address without persisting it (useful for crafting payloads before --next)"
    )
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
        flagPasswordFile: opts.passwordFile,
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
      const accounts = opts.peek
        ? storage.peekNextAccounts(1)
        : storage.addNextAccounts(1);
      console.log(accounts[0]!.address);
    });
}
