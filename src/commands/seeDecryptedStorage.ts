import { join } from "node:path";
import type { Command } from "commander";

import { cliOptions } from "../utils/cli-command-options";
import { cliError, cliErrorFromCaught } from "../utils/cli-errors";
import { DEFAULT_DATA_DIR } from "../utils/rpc";
import {
  resolveWalletDir,
  resolveWalletNameOrPrompt,
  resolveWalletPassword,
} from "../utils/wallets-util";
import { loadStore } from "../utils/aes-storage";

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
    .option("--wallet <name>", cliOptions.walletPickList)
    .option("--password <password>", cliOptions.password)
    .option("--non-interactive", cliOptions.nonInteractiveCompact)
    .option("--dataDir <path>", cliOptions.dataDir)
    .action(async (typeArg: string, opts: SeeDecryptedStorageOpts) => {
      const storageType = parseStorageType(typeArg);
      if (!storageType) {
        cliError(
          `<type> must be one of: ${STORAGE_TYPES.join(", ")} (got "${typeArg}")`
        );
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
      });
      if (!password) return;

      const fileName = TYPE_TO_FILENAME[storageType];
      const storePath = join(walletDir, fileName);

      let plaintext: string;
      try {
        ({ store: plaintext } = loadStore(storePath, password));
      } catch (e) {
        cliErrorFromCaught(e);
        return;
      }

      console.log(formatDecryptedPayload(plaintext));
    });
}
