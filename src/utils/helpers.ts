import { homedir } from "node:os";
import { join } from "node:path";
import type { JsonRpcProvider } from "ethers";

export const DEFAULT_DATA_DIR = join(homedir(), ".kohaku-cli");

/**
 * RPC endpoint from `--rpc-url` or the `RPC_URL` environment variable (trimmed).
 * Returns empty string if neither is set.
 */
export function resolveRpcUrl(optsRpcUrl?: string): string {
  return optsRpcUrl?.trim() || process.env.RPC_URL?.trim() || "";
}

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

export async function isAddressUsed(
  address: string,
  provider: JsonRpcProvider
): Promise<boolean> {
  const [nonce, balance] = await Promise.all([
    provider.getTransactionCount(address),
    provider.getBalance(address),
  ]);
  return nonce > 0 || balance > 0n;
}