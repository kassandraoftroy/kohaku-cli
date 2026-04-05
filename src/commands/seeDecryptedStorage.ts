import { join } from "node:path";
import { log } from "@clack/prompts";
import chalk from "chalk";
import type { Command } from "commander";

import { DEFAULT_DATA_DIR, walletNameToDirSegment } from "../utils/helpers";
import { resolveWalletNameOrPrompt } from "../utils/wallets";
import { loadStore } from "../utils/aes-storage";
import { resolveWalletPassword } from "../utils/wallet-password";

const STORAGE_TYPES = ["public", "railgun", "privacy-pools"] as const;
type StorageType = (typeof STORAGE_TYPES)[number];

const TYPE_TO_FILENAME: Record<StorageType, string> = {
  public: "public-accounts.json",
  railgun: "rg-storage.json",
  "privacy-pools": "ppv1-storage.json",
};

type SeeDecryptedStorageOpts = {
  wallet?: string;
  password?: string;
  nonInteractive?: boolean;
  dataDir?: string;
};

function formatDecryptedPayload(plaintext: string): string {
  const trimmed = plaintext.trim();
  if (trimmed === "" || trimmed === "{}") {
    return "{}";
  }
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return trimmed;
  }
}

function parseStorageType(raw: string): StorageType | null {
  const t = raw.trim().toLowerCase();
  if ((STORAGE_TYPES as readonly string[]).includes(t)) {
    return t as StorageType;
  }
  return null;
}

export function registerSeeDecryptedStorageCommand(program: Command): void {
  program
    .command("see-decrypted-storage <type>")
    .description(
      "Decrypt and print storage JSON: type is public | railgun | privacy-pools"
    )
    .option(
      "--wallet <name>",
      "Wallet name (omit to choose interactively from the list)"
    )
    .option("--password <password>", "Wallet password (required with --non-interactive; else prompted)")
    .option(
      "--non-interactive",
      "Agent mode: no prompts; requires --password; --wallet required if omitted"
    )
    .option("--dataDir <path>", "Kohaku data directory (default: ~/.kohaku-cli)")
    .action(async (typeArg: string, opts: SeeDecryptedStorageOpts) => {
      const storageType = parseStorageType(typeArg);
      if (!storageType) {
        log.error(
          chalk.red(
            `✖ <type> must be one of: ${STORAGE_TYPES.join(", ")} (got "${typeArg}")`
          )
        );
        process.exitCode = 1;
        return;
      }

      const dataDir = opts.dataDir ?? DEFAULT_DATA_DIR;
      const walletName = await resolveWalletNameOrPrompt({
        dataDir,
        wallet: opts.wallet,
        nonInteractive: opts.nonInteractive,
      });
      if (!walletName) {
        process.exitCode = 1;
        return;
      }
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

      const fileName = TYPE_TO_FILENAME[storageType];
      const storePath = join(walletDir, fileName);

      let plaintext: string;
      try {
        ({ store: plaintext } = loadStore(storePath, password));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        log.error(chalk.red(`✖ ${msg}`));
        process.exitCode = 1;
        return;
      }

      console.log(formatDecryptedPayload(plaintext));
    });
}
