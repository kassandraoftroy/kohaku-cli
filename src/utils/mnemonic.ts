import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Mnemonic } from "derive-railgun-keys";

import {
  decrypt,
  encrypt,
  generateSalt,
  isEncryptedEnvelopeV1,
  type EncryptedEnvelopeV1,
} from "./aes-storage";

/**
 * On-disk name for the encrypted BIP-39 seed file under each wallet directory
 * (`<dataDir>/wallets/<walletName>/seed.json`), alongside plugin `*-storage.json` files.
 */
export const SEED_FILENAME = "seed.json";

/** Identifies this file format (similar in spirit to Ethereum `version` / `crypto` JSON keystores). */
export const SEED_KIND = "kohaku-cli/seed" as const;

const DOC_VERSION = 1 as const;

export type SeedKeystoreV1 = {
  kind: typeof SEED_KIND;
  version: typeof DOC_VERSION;
  /**
   * Encrypted UTF-8 BIP-39 mnemonic (single line, space-separated words).
   * Uses PBKDF2-HMAC-SHA256 + AES-256-GCM; see `aes-storage.ts`.
   */
  crypto: EncryptedEnvelopeV1;
};

export function isSeedKeystoreV1(x: unknown): x is SeedKeystoreV1 {
  if (typeof x !== "object" || x === null) return false;
  const o = x as Record<string, unknown>;
  return (
    o.kind === SEED_KIND &&
    o.version === DOC_VERSION &&
    isEncryptedEnvelopeV1(o.crypto)
  );
}

export function normalizeValidatedMnemonic(phrase: string): string {
  const trimmed = phrase.trim();
  if (!trimmed) {
    throw new Error("Mnemonic cannot be empty");
  }
  if (!Mnemonic.validate(trimmed)) {
    throw new Error("Invalid BIP-39 mnemonic phrase");
  }
  return trimmed;
}

/**
 * Writes an encrypted seed keystore. The mnemonic is validated as BIP-39 before encryption.
 * Creates parent directories. File mode `0o600` where supported (user read/write only).
 */
export function writeSeedKeystore(
  mnemonicPhrase: string,
  password: string,
  walletDir: string
): void {
  const filePath = join(walletDir, SEED_FILENAME);
  if (existsSync(filePath)) {
    throw new Error(`File at ${filePath} already exists. Never overwrite existing seed.`)
  }
  const phrase = normalizeValidatedMnemonic(mnemonicPhrase);
  const salt = generateSalt();
  const crypto = encrypt(phrase, password, salt);
  const doc: SeedKeystoreV1 = {
    kind: SEED_KIND,
    version: DOC_VERSION,
    crypto,
  };
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(doc, null, 2), {
    encoding: "utf-8",
    mode: 0o600,
  });
}

/**
 * Decrypts and returns the BIP-39 mnemonic phrase (normalized spacing).
 */
export function readSeedKeystore(password: string, walletDir: string): string {
  const filePath = join(walletDir, SEED_FILENAME);
  if (!existsSync(filePath)) {
    throw new Error(`Seed keystore not found: ${filePath}`);
  }
  const parsed: unknown = JSON.parse(readFileSync(filePath, "utf-8"));
  if (!isSeedKeystoreV1(parsed)) {
    throw new Error("Invalid or unsupported seed keystore file");
  }
  let phrase: string;
  try {
    phrase = decrypt(parsed.crypto, password);
  } catch {
    throw new Error(
      "Failed to decrypt seed keystore (wrong password or corrupted file)"
    );
  }
  if (!Mnemonic.validate(phrase)) {
    throw new Error("Decrypted data is not a valid BIP-39 mnemonic");
  }
  return phrase;
}

export function generateMnemonic(): string {
  return Mnemonic.generate();
}
