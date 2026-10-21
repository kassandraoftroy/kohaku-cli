import type { Storage } from "@kohaku-eth/plugins";

/** Which note-secret derivation a plugin state belongs to. */
export type NoteDerivation = "legacy" | "signature";

/**
 * Prefix for signature-scheme Redux blobs inside the same encrypted wallet
 * file. Legacy state keeps the SDK's original keys.
 */
export const SIGNATURE_STORAGE_PREFIX = "sig:";

/**
 * Legacy notes when they can cover the withdrawal, otherwise signature notes.
 * `null` when neither scheme can cover it alone.
 */
export function chooseDerivationScheme(opts: {
  legacyCanCover: boolean;
  signatureCanCover: boolean;
}): NoteDerivation | null {
  if (opts.legacyCanCover) return "legacy";
  if (opts.signatureCanCover) return "signature";
  return null;
}

/** Largest amount one scheme can spend. The two balances are not added. */
export function largerSchemeCap(legacyCap: bigint, signatureCap: bigint): bigint {
  return legacyCap > signatureCap ? legacyCap : signatureCap;
}

export function schemeSpendLine(scheme: NoteDerivation): string {
  return scheme === "legacy"
    ? "Spending legacy notes."
    : "Spending signature notes.";
}

export function schemeCoverError(opts: {
  legacyLabel: string;
  signatureLabel: string;
}): string {
  return `Neither legacy nor signature notes can cover this withdrawal in one transaction. Legacy spendable: ${opts.legacyLabel}. Signature spendable: ${opts.signatureLabel}. Unshield one scheme at a time.`;
}

/** Same storage object, with every key prefixed. Writes stay in one file. */
export function prefixStorage(storage: Storage, prefix: string): Storage {
  return {
    _brand: "Storage",
    async get(key: string): Promise<string | null> {
      return storage.get(`${prefix}${key}`);
    },
    async set(key: string, value: string): Promise<void> {
      await storage.set(`${prefix}${key}`, value);
    },
  };
}
