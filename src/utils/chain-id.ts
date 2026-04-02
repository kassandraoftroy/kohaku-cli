import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const CHAIN_ID_FILENAME = ".chainId";

export function writeWalletChainId(chainIdString: string, walletDir: string): void {
  const filePath = join(walletDir, CHAIN_ID_FILENAME);
  if (existsSync(filePath)) {
    throw new Error(`File at ${filePath} already exists. Refusing to overwrite chain ID.`);
  }
  writeFileSync(filePath, `${chainIdString}\n`, {
    encoding: "utf-8",
    mode: 0o600,
  });
}

export function readWalletChainId(walletDir: string): string {
  const filePath = join(walletDir, CHAIN_ID_FILENAME);
  if (!existsSync(filePath)) {
    throw new Error(`Wallet chain ID file not found: ${filePath}`);
  }
  return readFileSync(filePath, "utf-8").trim();
}
