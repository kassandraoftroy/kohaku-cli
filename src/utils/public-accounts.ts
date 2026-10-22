import { join } from "node:path";
import { loadStore, saveStore } from "./aes-storage";
import { Mnemonic } from "derive-railgun-keys";
import { getAddress } from "viem";
import { addressFromPrivateKey } from "./viem-tx.js";

function accountsStorePathForWallet(walletDir: string): string {
  return join(walletDir, "public-accounts.json");
}

export type PublicAccount = {
  address: string;
  index: number;
  priv: string;
  tags: string[];
  lastUpdated: number;
  ethBalance: string;
  erc20Balances: Record<string, string>;
  erc721Holdings: Record<string, string[]>;
}

type PublicAccountsStore = {
  nextIndex: number;
  accounts: Record<number, PublicAccount>;
}

export type PublicAccountsStorage = {

  setAccounts(accts: PublicAccount[]): void;

  getAccount(key: number): PublicAccount | null;

  getAccounts(): PublicAccount[];

  addNextAccounts(n: number): PublicAccount[];

  /** Derive the next n accounts without advancing nextIndex or writing to disk. */
  peekNextAccounts(n: number): PublicAccount[];
};

/** How many already-used HD indexes `--next` will save and skip. */
const MAX_USED_PUBLIC_ACCOUNT_SKIPS = 32;

/** How many unstored HD indexes `balances` checks past the cursor. */
export const BALANCE_PUBLIC_ACCOUNT_LOOKAHEAD = 2;

export function savePublicAccounts(walletDir: string, password: string, accounts: PublicAccountsStore, saltRef: { current: Uint8Array | null }): void {
  const storePath = accountsStorePathForWallet(walletDir);
  saveStore(storePath, JSON.stringify(accounts), password, saltRef);
}

export function findPublicAccountByAddress(
  storage: PublicAccountsStorage,
  address: string
): PublicAccount | undefined {
  const lower = getAddress(address).toLowerCase();
  return storage.getAccounts().find((a) => a.address.toLowerCase() === lower);
}

/** Standard public-account path used by derive-railgun-keys. */
export function publicAccountDerivationPath(index: number): string {
  if (!Number.isSafeInteger(index) || index < 0) {
    throw new Error(`Invalid public account index: ${index}`);
  }
  return `m/44'/60'/0'/0/${index}`;
}

function derivePublicAccountAtIndex(mnemonic: string, index: number): PublicAccount {
  const priv = Mnemonic.to0xPrivateKeyByIndex(mnemonic, index);
  const address = addressFromPrivateKey(priv);
  return {
    address,
    index,
    priv,
    tags: [],
    lastUpdated: 0,
    ethBalance: "0",
    erc20Balances: {},
    erc721Holdings: {},
  };
}

export function makePublicAccountsStorage(walletDir: string, mnemonic: string, password: string): PublicAccountsStorage {
  const storePath = accountsStorePathForWallet(walletDir);
  const { store: initial, salt } = loadStore(storePath, password);
  const store: PublicAccountsStore = initial != "{}" ? JSON.parse(initial) : {
    nextIndex: 0,
    accounts: {},
  };
  return {
    setAccounts: (accts: PublicAccount[]) => {
      accts.forEach(acct => {
        store.accounts[acct.index] = acct;
      });
      savePublicAccounts(walletDir, password, store, { current: salt });
    },
    getAccount: (index: number) => {
      if (store.nextIndex <= index) {
        return null;
      }
      return store.accounts[index];
    },
    getAccounts: () => {
      return Object.values(store.accounts).sort((a, b) => a.index - b.index);
    },
    addNextAccounts: (n: number) => {
      if (n <= 0) {
        throw new Error("addNextAccounts: n must be positive");
      }
      const created: PublicAccount[] = [];
      for (let k = 0; k < n; k += 1) {
        const index = store.nextIndex++;
        const acct = derivePublicAccountAtIndex(mnemonic, index);
        store.accounts[index] = acct;
        created.push(acct);
      }
      savePublicAccounts(walletDir, password, store, { current: salt });
      return created;
    },
    peekNextAccounts: (n: number) => {
      if (n <= 0) {
        throw new Error("peekNextAccounts: n must be positive");
      }
      const created: PublicAccount[] = [];
      for (let k = 0; k < n; k += 1) {
        created.push(derivePublicAccountAtIndex(mnemonic, store.nextIndex + k));
      }
      return created;
    },
  };
}

/**
 * Next HD account that is not already on-chain.
 * A used index is stored (so its key stays in the wallet) and the cursor advances.
 * The returned account is only peeked; the caller persists it after a successful broadcast.
 */
export async function selectNextUnusedPublicAccount(
  storage: Pick<PublicAccountsStorage, "peekNextAccounts" | "addNextAccounts">,
  isUsed: (address: string) => Promise<boolean>
): Promise<{ account: PublicAccount; skipped: PublicAccount[] }> {
  const skipped: PublicAccount[] = [];
  for (let n = 0; n <= MAX_USED_PUBLIC_ACCOUNT_SKIPS; n += 1) {
    const fresh = storage.peekNextAccounts(1)[0];
    if (!fresh) {
      throw new Error("Could not derive the next public account.");
    }
    if (!(await isUsed(fresh.address))) {
      return { account: fresh, skipped };
    }
    if (n === MAX_USED_PUBLIC_ACCOUNT_SKIPS) break;
    skipped.push(fresh);
    storage.addNextAccounts(1);
  }
  throw new Error(
    `The next ${MAX_USED_PUBLIC_ACCOUNT_SKIPS + 1} public accounts already have a nonce, balance, or code.`
  );
}

/**
 * Save a leading run of on-chain HD indexes, at most `lookahead` past the cursor.
 * Stops at the first unused index so an unused account is not persisted.
 * Returned accounts are stored; their balances are filled by the caller.
 */
export async function adoptUsedPublicAccounts(
  storage: Pick<PublicAccountsStorage, "peekNextAccounts" | "addNextAccounts">,
  isUsed: (address: string) => Promise<boolean>,
  lookahead = BALANCE_PUBLIC_ACCOUNT_LOOKAHEAD
): Promise<PublicAccount[]> {
  if (!Number.isSafeInteger(lookahead) || lookahead < 0) {
    throw new Error(`Invalid public account lookahead: ${lookahead}`);
  }
  const peeked = storage.peekNextAccounts(lookahead);
  const adopted: PublicAccount[] = [];
  for (const account of peeked) {
    if (!(await isUsed(account.address))) break;
    storage.addNextAccounts(1);
    adopted.push(account);
  }
  return adopted;
}