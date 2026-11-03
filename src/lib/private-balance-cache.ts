import { createHash } from "node:crypto";
import { join } from "node:path";
import type { AssetAmount } from "@kohaku-eth/plugins";
import { loadStore, saveStore } from "../utils/aes-storage.js";
import { fileFingerprint } from "../utils/file-fingerprint.js";
import type { SupportedProtocol } from "../utils/plugins.js";

export const PRIVATE_BALANCE_MAX_AGE_MS = 60_000;

export type PrivateBalanceData = {
  balances: AssetAmount[];
  railgunAddress?: string;
  legacyBalances?: AssetAmount[];
  rawNotes?: unknown[];
};
export type PrivateBalanceFreshness = { checkedAt: string; fromCache: boolean };
type Entry = { checkedAt: number; fingerprint: string; data: PrivateBalanceData };
type Cache = { version: 1; identity: string; entries: Partial<Record<SupportedProtocol, Entry>> };

const STORE_FILE: Record<SupportedProtocol, string> = {
  railgun: "rg-v2-storage.json", "privacy-pools": "ppv1-storage.json", tornado: "tc-storage.json",
};

/** Read-only display cache. Spending and explicit protocol syncs never consult it. */
export function privateBalanceCache(opts: {
  walletDir: string; password: string; mnemonic: string; chainId: bigint; rpcUrl: string;
}): {
  read(protocol: SupportedProtocol, includeNotes: boolean, now?: number): Entry | null;
  write(protocol: SupportedProtocol, data: PrivateBalanceData, checkedAt?: number): void;
} {
  const path = join(opts.walletDir, "private-balances-cache.json");
  const identity = createHash("sha256").update(JSON.stringify([
    "private-balance-view-v1", opts.chainId.toString(), opts.rpcUrl, opts.mnemonic,
  ])).digest("hex");
  let cache: Cache = { version: 1, identity, entries: {} };
  const saltRef: { current: Uint8Array | null } = { current: null };
  try {
    const loaded = loadStore(path, opts.password);
    const value = JSON.parse(loaded.store, (_key, value) => {
      if (value && typeof value === "object" && Object.keys(value).length === 1 &&
          typeof value.kohakuBigInt === "string" && /^-?\d+$/.test(value.kohakuBigInt)) {
        return BigInt(value.kohakuBigInt);
      }
      return value;
    }) as Cache;
    if (value.version === 1 && value.identity === identity && value.entries && typeof value.entries === "object") {
      cache = value;
      saltRef.current = loaded.salt;
    }
  } catch { /* Corrupt, incompatible or old-password display caches are disposable. */ }

  const fingerprint = (protocol: SupportedProtocol) => JSON.stringify([
    fileFingerprint(join(opts.walletDir, STORE_FILE[protocol])),
    fileFingerprint(join(opts.walletDir, ".encrypted-seed.json")),
    // Activity writes use atomic rename, which also changes the directory.
    fileFingerprint(join(opts.walletDir, "activity")),
  ]);

  return {
    read(protocol, includeNotes, now = Date.now()) {
      const entry = cache.entries[protocol];
      if (!entry || !Number.isFinite(entry.checkedAt) || now < entry.checkedAt ||
          now - entry.checkedAt >= PRIVATE_BALANCE_MAX_AGE_MS ||
          entry.fingerprint !== fingerprint(protocol) || !Array.isArray(entry.data?.balances) ||
          !entry.data.balances.every((row) => typeof row?.amount === "bigint") ||
          (includeNotes && !Array.isArray(entry.data.rawNotes))) return null;
      return entry;
    },
    write(protocol, data, checkedAt = Date.now()) {
      cache.entries[protocol] = { checkedAt, fingerprint: fingerprint(protocol), data };
      try {
        saveStore(path, JSON.stringify(cache, (_key, value) => typeof value === "bigint"
          ? { kohakuBigInt: value.toString() } : value), opts.password, saltRef);
      } catch { /* A failed display-cache save must not fail a completed wallet sync. */ }
    },
  };
}
