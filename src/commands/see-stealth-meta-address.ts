import type { Command } from "commander";

import { deriveStealthKeypair } from "../lib/stealth/keys.js";
import { readSeedKeystore } from "../utils/mnemonic";
import { DEFAULT_DATA_DIR } from "../utils/rpc";
import { cliOptions, passwordFileOption } from "../utils/cli-command-options";
import { cliErrorFromCaught } from "../utils/cli-errors";
import {
  expectedChainIdStringFromWalletDir,
  resolveWalletDir,
  resolveWalletNameOrPrompt,
  resolveWalletPassword,
} from "../utils/wallets-util";

type SeeStealthMetaAddressOpts = {
  wallet?: string;
  password?: string;
  passwordFile?: string;
  nonInteractive?: boolean;
  dataDir?: string;
};

export function registerSeeStealthMetaAddressCommand(program: Command): void {
  program
    .command("see-stealth-meta-address")
    .description(
      "Print this wallet's scheme-1 stealth meta-address URI (st:<network>:0x…)"
    )
    .option("--wallet <name>", cliOptions.walletPickList)
    .option("--password <password>", cliOptions.password)
    .addOption(passwordFileOption())
    .option("--non-interactive", cliOptions.nonInteractiveCompact)
    .option("--dataDir <path>", cliOptions.dataDir)
    .action(async (opts: SeeStealthMetaAddressOpts) => {
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
      let chainId: bigint;
      try {
        mnemonic = readSeedKeystore(password, walletDir);
        chainId = BigInt(expectedChainIdStringFromWalletDir(walletDir));
      } catch (e) {
        cliErrorFromCaught(e);
        return;
      }

      const { stealthMetaAddressURI } = deriveStealthKeypair(mnemonic, chainId);
      console.log(stealthMetaAddressURI);
    });
}
