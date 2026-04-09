import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "@clack/prompts";
import { password, select } from "@inquirer/prompts";

import { cliError } from "./cli-errors";
import { SEED_FILENAME } from "./mnemonic";

// --- Paths: CLI wallet name → filesystem ---

/** Trimmed wallet name from CLI, or null if missing/blank (after trim). */
export function parseRequiredWalletName(wallet: string | undefined): string | null {
  const trimmed = wallet?.trim();
  return trimmed ? trimmed : null;
}

export function walletNameToDirSegment(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new Error("Wallet name cannot be empty");
  }
  const safe = trimmed.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  if (!safe) {
    throw new Error(
      "Wallet name must contain at least one letter, digit, dot, hyphen, or underscore"
    );
  }
  return safe;
}

/** Resolved wallet directory: `<dataDir>/<safe-wallet-name-segment>`. */
export function resolveWalletDir(dataDir: string, walletName: string): string {
  return join(dataDir, walletNameToDirSegment(walletName));
}

// --- `.wallet-type` file (mainnet vs testnet) ---

export const WALLET_TYPE_FILENAME = ".wallet-type";

export function writeWalletType(walletType: string, walletDir: string): void {
  const filePath = join(walletDir, WALLET_TYPE_FILENAME);
  if (existsSync(filePath)) {
    throw new Error(`File at ${filePath} already exists. Refusing to overwrite wallet type.`);
  }
  writeFileSync(filePath, `${walletType}\n`, {
    encoding: "utf-8",
  });
}

export function readWalletType(walletDir: string): string {
  const filePath = join(walletDir, WALLET_TYPE_FILENAME);
  if (!existsSync(filePath)) {
    throw new Error(`Wallet chain ID file not found: ${filePath}`);
  }
  return readFileSync(filePath, "utf-8").trim();
}

/** Canonical chain id string for RPC checks: mainnet `1`, Sepolia `11155111`. */
export function expectedChainIdStringFromWalletDir(walletDir: string): string {
  return readWalletType(walletDir) === "testnet" ? "11155111" : "1";
}

// --- Unlock password (CLI flags vs prompt) ---

/**
 * Resolves wallet unlock password: use --password when set, else prompt (interactive)
 * or error when --non-interactive and flag is missing.
 */
export async function resolveWalletPassword(opts: {
  flagPassword?: string | undefined;
  nonInteractive?: boolean | undefined;
  validate?: ((password: string) => void | Promise<void>) | undefined;
}): Promise<string | null> {
  const fromFlag = opts.flagPassword?.trim();
  if (fromFlag) {
    const candidates: string[] = [fromFlag];
    if (existsSync(fromFlag)) {
      try {
        const fromFile = readFileSync(fromFlag, "utf-8").trim();
        if (fromFile && fromFile !== fromFlag) {
          candidates.push(fromFile);
        }
      } catch {
        // Ignore file read errors; keep raw password candidate.
      }
    }
    if (opts.validate) {
      let lastErr: unknown;
      for (const pw of candidates) {
        try {
          await opts.validate(pw);
          return pw;
        } catch (e) {
          lastErr = e;
        }
      }
      throw lastErr instanceof Error ? lastErr : new Error("Invalid wallet password.");
    }
    return candidates[0]!;
  }
  if (opts.nonInteractive) {
    cliError("--password is required when using --non-interactive.");
    return null;
  }
  for (;;) {
    const pw = await password({
      message: "Wallet password:",
      mask: "*",
    });
    if (pw?.trim()) {
      const trimmed = pw.trim();
      if (!opts.validate) {
        return trimmed;
      }
      try {
        await opts.validate(trimmed);
        return trimmed;
      } catch (e) {
        log.warn(e instanceof Error ? e.message : "Invalid wallet password.");
        continue;
      }
    }
    log.warn("Password cannot be empty.");
  }
}

/**
 * For wallet creation we cannot validate against existing encrypted data yet.
 * If --password points to an existing file, use its trimmed contents; otherwise
 * treat --password as the literal password text.
 */
export function resolvePasswordInputPreferFile(
  flagPassword: string | undefined
): string | null {
  const raw = flagPassword?.trim();
  if (!raw) return null;

  if (existsSync(raw)) {
    try {
      const fromFile = readFileSync(raw, "utf-8").trim();
      if (fromFile) return fromFile;
    } catch {
      // Fall back to using raw flag text as password.
    }
  }

  return raw;
}

// --- Listing & selection ---

export type WalletNetworkKind = "mainnet" | "testnet" | "unknown";

export function walletNetworkKind(walletDir: string): WalletNetworkKind {
  const typePath = join(walletDir, WALLET_TYPE_FILENAME);
  if (!existsSync(typePath)) {
    return "unknown";
  }
  const raw = readFileSync(typePath, "utf-8").trim().toLowerCase();
  if (raw === "testnet" || raw === "mainnet") {
    return raw as WalletNetworkKind;
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
    cliError("--wallet <name> is required when using --non-interactive.");
    return null;
  }

  const names = listWalletDirNames(opts.dataDir);
  if (names.length === 0) {
    cliError("No wallets found. Create one with kohaku create-wallet.");
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
