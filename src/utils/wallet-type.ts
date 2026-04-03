import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const WALLET_TYPE_FILENAME = ".wallet-type";

export function writeWalletType(walletType: string, walletDir: string): void {
  const filePath = join(walletDir, WALLET_TYPE_FILENAME);
  if (existsSync(filePath)) {
    throw new Error(`File at ${filePath} already exists. Refusing to overwrite wallet type.`);
  }
  writeFileSync(filePath, `${walletType}\n`, {
    encoding: "utf-8",
    mode: 0o600,
  });
}

export function readWalletType(walletDir: string): string {
  const filePath = join(walletDir, WALLET_TYPE_FILENAME);
  if (!existsSync(filePath)) {
    throw new Error(`Wallet chain ID file not found: ${filePath}`);
  }
  return readFileSync(filePath, "utf-8").trim();
}
