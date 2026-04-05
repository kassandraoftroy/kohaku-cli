import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { select } from "@inquirer/prompts";
import { log } from "@clack/prompts";
import chalk from "chalk";

import { parseRequiredWalletName } from "./helpers";
import { SEED_FILENAME } from "./mnemonic";
import { WALLET_TYPE_FILENAME } from "./wallet-type";

export type WalletNetworkKind = "mainnet" | "testnet" | "unknown";

export function walletNetworkKind(walletDir: string): WalletNetworkKind {
  const typePath = join(walletDir, WALLET_TYPE_FILENAME);
  if (!existsSync(typePath)) {
    return "unknown";
  }
  const raw = readFileSync(typePath, "utf-8").trim().toLowerCase();
  if (raw === "testnet") {
    return "testnet";
  }
  if (raw === "mainnet") {
    return "mainnet";
  }
  return "unknown";
}

export function listWalletDirNames(dataDir: string): string[] {
  if (!existsSync(dataDir)) {
    return [];
  }
  const entries = readdirSync(dataDir, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => existsSync(join(dataDir, name, SEED_FILENAME)))
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
}

function networkLabel(kind: WalletNetworkKind): string {
  if (kind === "unknown") return "unknown";
  return kind === "mainnet" ? "mainnet" : "testnet";
}

/**
 * Resolves `--wallet` when set; otherwise prompts to pick a wallet (arrow keys) or errors in non-interactive mode.
 */
export async function resolveWalletNameOrPrompt(opts: {
  dataDir: string;
  wallet?: string;
  nonInteractive?: boolean;
}): Promise<string | null> {
  const parsed = parseRequiredWalletName(opts.wallet);
  if (parsed) {
    return parsed;
  }
  if (opts.nonInteractive) {
    log.error(chalk.red("✖ --wallet <name> is required when using --non-interactive."));
    return null;
  }

  const names = listWalletDirNames(opts.dataDir);
  if (names.length === 0) {
    log.error(chalk.red("✖ No wallets found. Create one with kohaku create-wallet."));
    return null;
  }
  if (names.length === 1) {
    return names[0]!;
  }

  const choices = names.map((name) => {
    const kind = walletNetworkKind(join(opts.dataDir, name));
    return {
      name: `${name} (${networkLabel(kind)})`,
      value: name,
    };
  });

  return select({
    message: "Select a wallet",
    choices,
  });
}
