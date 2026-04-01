import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  createCipheriv,
  createDecipheriv,
  pbkdf2Sync,
  randomBytes,
} from "node:crypto";

/** PBKDF2 iterations (OWASP 2023 guidance for SHA-256). */
const PBKDF2_ITERATIONS = 310_000;
const PBKDF2_DIGEST = "sha256";
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;
const GCM_IV_LENGTH = 12;

const VERSION = 1;

export type EncryptedEnvelopeV1 = {
  v: typeof VERSION;
  salt: string;
  iv: string;
  tag: string;
  ciphertext: string;
};

export function isEncryptedEnvelopeV1(x: unknown): x is EncryptedEnvelopeV1 {
  if (typeof x !== "object" || x === null) return false;
  const o = x as Record<string, unknown>;
  return (
    o.v === VERSION &&
    typeof o.salt === "string" &&
    typeof o.iv === "string" &&
    typeof o.tag === "string" &&
    typeof o.ciphertext === "string"
  );
}

export function generateSalt(): Uint8Array {
  return randomBytes(SALT_LENGTH);
}

/**
 * Derives a 32-byte AES-256 key from a password and salt (PBKDF2-HMAC-SHA256).
 * The salt is stored alongside ciphertext in the wallet file (it is not secret).
 */
export function deriveKeyFromPassword(
  password: string,
  salt: Uint8Array
): Buffer {
  if (!password) {
    throw new Error("Password cannot be empty");
  }
  return pbkdf2Sync(
    password,
    salt,
    PBKDF2_ITERATIONS,
    KEY_LENGTH,
    PBKDF2_DIGEST
  );
}

export type DerivedKey = Buffer;

export function encrypt(
  data: string,
  password: string,
  salt: Uint8Array
): EncryptedEnvelopeV1 {
  const key = deriveKeyFromPassword(password, salt);
  const iv = randomBytes(GCM_IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(data, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return {
    v: VERSION,
    salt: Buffer.from(salt).toString("base64"),
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

export function decrypt(
  envelope: EncryptedEnvelopeV1,
  password: string
): string {
  const salt = Buffer.from(envelope.salt, "base64");
  const key = deriveKeyFromPassword(password, salt);
  const iv = Buffer.from(envelope.iv, "base64");
  const tag = Buffer.from(envelope.tag, "base64");
  const ciphertext = Buffer.from(envelope.ciphertext, "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString("utf8");
  return plaintext;
}

export function loadStore(
  storePath: string,
  password: string
): { store: string; salt: Uint8Array | null } {
  if (!existsSync(storePath)) {
    return { store: JSON.stringify({}), salt: null };
  }
  const parsed: unknown = JSON.parse(readFileSync(storePath, "utf-8"));
  if (isEncryptedEnvelopeV1(parsed)) {
    try {
      const store = JSON.parse(decrypt(parsed, password));
      const salt = Buffer.from(parsed.salt, "base64");
      return { store, salt };
    } catch {
      throw new Error(
        "Failed to decrypt storage (wrong password or corrupted file)"
      );
    }
  }

  throw new Error("Invalid storage file");
}

export function saveStore(
  storePath: string,
  store: string,
  password: string,
  saltRef: { current: Uint8Array | null }
): void {
  if (!saltRef.current) {
    saltRef.current = generateSalt();
  }
  const envelope = encrypt(store, password, saltRef.current);
  mkdirSync(dirname(storePath), { recursive: true });
  writeFileSync(storePath, JSON.stringify(envelope, null, 2));
}
