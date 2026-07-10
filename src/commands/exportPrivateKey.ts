import { confirm } from "@inquirer/prompts";
import { Mnemonic } from "derive-railgun-keys";
import type { Command } from "commander";
import { computeAddress, getAddress, isAddress } from "ethers";

import { readSeedKeystore } from "../utils/mnemonic";
import { findPublicAccountByAddress, makePublicAccountsStorage } from "../utils/public-accounts";
import { DEFAULT_DATA_DIR } from "../utils/rpc";
import { cliOptions } from "../utils/cli-command-options";
import { cliError, cliErrorFromCaught } from "../utils/cli-errors";
import {
  resolveWalletDir,
  resolveWalletNameOrPrompt,
  resolveWalletPassword,
} from "../utils/wallets-util";

type ExportPrivateKeyOpts = {
  wallet?: string;
  password?: string;
  address?: string;
  index?: string;
  nonInteractive?: boolean;
  dataDir?: string;
};

function parseIndex(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) return null;
  return n;
}

export function registerExportPrivateKeyCommand(program: Command): void {
  program
    .command("export-private-key")
    .description("Export the private key for a wallet public account")
    .option("--wallet <name>", cliOptions.walletPickList)
    .option("--password <password>", cliOptions.password)
    .option("--address <address>", "Public account address to export")
    .option("--index <index>", "Public account index to export")
    .option("--non-interactive", cliOptions.nonInteractiveCompact)
    .option("--dataDir <path>", cliOptions.dataDir)
    .action(async (opts: ExportPrivateKeyOpts) => {
      if (opts.address && opts.index) {
        cliError("Provide only one of --address or --index.");
        return;
      }
      if (!opts.address && !opts.index) {
        cliError("Missing account selector. Provide --address or --index.");
        return;
      }

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

      let privateKey: string;
      let address: string;
      let indexLabel: string;

      try {
        if (opts.index) {
          const idx = parseIndex(opts.index);
          if (idx === null) {
            cliError("--index must be a non-negative integer.");
            return;
          }
          const account = storage.getAccount(idx);
          if (account) {
            privateKey = account.priv;
            address = account.address;
          } else {
            // Allow exporting by derivation index even if not persisted yet.
            privateKey = Mnemonic.to0xPrivateKeyByIndex(mnemonic, idx);
            address = getAddress(computeAddress(privateKey));
          }
          indexLabel = idx.toString();
        } else {
          const raw = opts.address!;
          if (!isAddress(raw)) {
            cliError(`Invalid --address: ${raw}`);
            return;
          }
          const normalized = getAddress(raw);
          const account = findPublicAccountByAddress(storage, normalized);
          if (!account) {
            cliError(
              `Address ${normalized} is not in this wallet's persisted public accounts. Use --index to export by derivation index.`
            );
            return;
          }
          privateKey = account.priv;
          address = account.address;
          indexLabel = account.index.toString();
        }
      } catch (e) {
        cliErrorFromCaught(e);
        return;
      }

      if (!opts.nonInteractive) {
        const confirmed = await confirm({
          message: `Reveal private key for [${indexLabel}] ${address}? This will print sensitive key material to your terminal.`,
          default: false,
        });
        if (!confirmed) {
          cliError("Cancelled by user.");
          return;
        }
      }

      console.log(privateKey);
    });
}
