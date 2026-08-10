import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Wallet-local floor for first ERC-5564 announcement scans. */
export const STEALTH_START_BLOCK_FILENAME = ".stealth-start-block";

function filePath(walletDir: string): string {
  return join(walletDir, STEALTH_START_BLOCK_FILENAME);
}

/**
 * Persist the inclusive lower bound for stealth announcement history.
 * Refuses to overwrite an existing file (set once at wallet creation / import).
 */
export function writeStealthStartBlock(walletDir: string, block: bigint): void {
  if (block < 0n) {
    throw new Error("Stealth start block must be >= 0.");
  }
  const path = filePath(walletDir);
  if (existsSync(path)) {
    throw new Error(
      `File at ${path} already exists. Refusing to overwrite stealth start block.`
    );
  }
  writeFileSync(path, `${block.toString()}\n`, { encoding: "utf-8" });
}

/** Read `.stealth-start-block` if present; otherwise `null`. */
export function readStealthStartBlock(walletDir: string): bigint | null {
  const path = filePath(walletDir);
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf-8").trim();
  if (!raw) {
    throw new Error(`Stealth start block file is empty: ${path}`);
  }
  if (!/^(0x[0-9a-fA-F]+|[0-9]+)$/.test(raw)) {
    throw new Error(
      `Invalid stealth start block in ${path} (got "${raw}").`
    );
  }
  let block: bigint;
  try {
    block = BigInt(raw);
  } catch {
    throw new Error(`Invalid stealth start block in ${path} (got "${raw}").`);
  }
  if (block < 0n) {
    throw new Error(`Stealth start block in ${path} must be >= 0.`);
  }
  return block;
}
