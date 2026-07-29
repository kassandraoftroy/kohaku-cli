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