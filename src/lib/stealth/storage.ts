import { join } from "node:path";
import { getAddress, type Hex } from "viem";

import { loadStore, saveStore } from "../../utils/aes-storage.js";

export type StealthAccount = {
  /** Local sequential id for CLI selectors (`s0`, `s1`, …). */
  stealthIndex: number;
  address: string;
  priv: string;
  ephemeralPublicKey: Hex;
  viewTag?: string;
  schemeId: number;
  announcementTxHash?: string;
  announcementBlock?: string;
  /** Wallet identity name this payment was associated with (from init-profile). */
  name?: string;
  lastUpdated: number;
  ethBalance: string;
  erc20Balances: Record<string, string>;
};

/** Cached wallet identity from init-profile / balances onchain discovery. */
export type StealthWalletProfile = {
  /** Preferred GNS/ENS/WNS name, or the registrant 0x address when no reverse name. */
  name: string;
  /** HD index that owns/registered the profile. */
  index: number;
  /** Checksummed registrant address. */
  address: string;
  /** `st:<chain>:0x…` stealth meta-address URI. */
  stealthMetaAddressURI: string;
};

export type StealthAccountsStore = {
  nextStealthIndex: number;
  /** Our published meta-address URI (from init-profile / derive). Synced from `profile`. */
  metaAddressURI?: string;
  /** Primary name / address label (synced from `profile`). */
  name?: string;
  /**
   * Wallet identity profile.
   * - missing / undefined: legacy store — needs onchain check once
   * - null: explicitly cleared (e.g. failed --resync-profile) — needs onchain check
   * - object: stable cached profile — skip network unless --resync-profile
   */
  profile?: StealthWalletProfile | null;
  /** Inclusive last block scanned for announcements. */
  lastScannedBlock?: string;
  /**
   * True once we've scanned from the announcer deploy block at least once.
   * Missing/false on older stores that only did a truncated lookback — next
   * balances run backfills from deploy → latest (chunked).
   */
  fullHistoryScanned?: boolean;
  accounts: Record<number, StealthAccount>;
};

export type StealthAccountsStorage = {
  getStore(): StealthAccountsStore;
  save(): void;
  getAccounts(): StealthAccount[];
  getAccount(stealthIndex: number): StealthAccount | null;
  findByAddress(address: string): StealthAccount | undefined;
  upsertAccount(acct: Omit<StealthAccount, "stealthIndex"> & { stealthIndex?: number }): StealthAccount;
  /** Legacy partial meta write; prefer {@link setProfile} for identity. */
  setMeta(meta: { metaAddressURI?: string; name?: string }): void;
  setProfile(profile: StealthWalletProfile): void;
  /** Mark profile as needing onchain re-check (`null`); clears synced name/URI. */
  clearProfile(): void;
  setLastScannedBlock(block: bigint): void;
  markFullHistoryScanned(): void;
};

function storePath(walletDir: string): string {
  return join(walletDir, "stealth-accounts.json");
}

export function makeStealthAccountsStorage(
  walletDir: string,
  password: string
): StealthAccountsStorage {
  const path = storePath(walletDir);
  const { store: initial, salt } = loadStore(path, password);
  const store: StealthAccountsStore =
    initial !== "{}"
      ? (JSON.parse(initial) as StealthAccountsStore)
      : { nextStealthIndex: 0, accounts: {} };
  if (!store.accounts) store.accounts = {};
  if (typeof store.nextStealthIndex !== "number") store.nextStealthIndex = 0;

  const persist = () => {
    saveStore(path, JSON.stringify(store), password, { current: salt });
  };

  return {
    getStore: () => store,
    save: persist,
    getAccounts: () =>
      Object.values(store.accounts).sort(
        (a, b) => a.stealthIndex - b.stealthIndex
      ),
    getAccount: (stealthIndex) => store.accounts[stealthIndex] ?? null,
    findByAddress: (address) => {
      const lower = getAddress(address).toLowerCase();
      return Object.values(store.accounts).find(
        (a) => a.address.toLowerCase() === lower
      );
    },
    upsertAccount: (acct) => {
      const existing = Object.values(store.accounts).find(
        (a) => a.address.toLowerCase() === acct.address.toLowerCase()
      );
      if (existing) {
        const merged: StealthAccount = {
          ...existing,
          ...acct,
          stealthIndex: existing.stealthIndex,
          address: getAddress(acct.address),
        };
        store.accounts[existing.stealthIndex] = merged;
        persist();
        return merged;
      }
      const stealthIndex = store.nextStealthIndex++;
      const created: StealthAccount = {
        ...acct,
        stealthIndex,
        address: getAddress(acct.address),
      };
      store.accounts[stealthIndex] = created;
      persist();
      return created;
    },
    setMeta: (meta) => {
      if (meta.metaAddressURI !== undefined) {
        store.metaAddressURI = meta.metaAddressURI;
      }
      if (meta.name !== undefined) store.name = meta.name;
      persist();
    },
    setProfile: (profile) => {
      const address = getAddress(profile.address);
      store.profile = {
        name: profile.name,
        index: profile.index,
        address,
        stealthMetaAddressURI: profile.stealthMetaAddressURI,
      };
      store.name = profile.name;
      store.metaAddressURI = profile.stealthMetaAddressURI;
      persist();
    },
    clearProfile: () => {
      store.profile = null;
      delete store.name;
      delete store.metaAddressURI;
      persist();
    },
    setLastScannedBlock: (block) => {
      store.lastScannedBlock = block.toString();
      persist();
    },
    markFullHistoryScanned: () => {
      store.fullHistoryScanned = true;
      persist();
    },
  };
}

/** Parse `s0` / `stealth:0` selectors. */
export function parseStealthIndex(fromValue: string): number | null {
  const m = /^(?:s|stealth:)(\d+)$/i.exec(fromValue.trim());
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isInteger(n) || n < 0) return null;
  return n;
}

export function formatStealthSelector(stealthIndex: number): string {
  return `s${stealthIndex}`;
}

/** True when `profile` is a stable cached object (not missing/null). */
export function hasCachedStealthProfile(
  store: StealthAccountsStore
): store is StealthAccountsStore & { profile: StealthWalletProfile } {
  return store.profile != null && typeof store.profile === "object";
}
