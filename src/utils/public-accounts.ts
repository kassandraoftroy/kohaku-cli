import { join } from "node:path";
import { loadStore, saveStore } from "./aes-storage";
import { Mnemonic } from "derive-railgun-keys";
import { ethers } from "ethers";

function accountsStorePathForWallet(walletDir: string, chainIdString: string): string {
  return join(walletDir, `public-accounts-${chainIdString}.json`);
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

  generateNextIndex(): PublicAccount;
};

export function savePublicAccounts(walletDir: string, password: string, chainIdString: string, accounts: PublicAccountsStore, saltRef: { current: Uint8Array | null }): void {
  const storePath = accountsStorePathForWallet(walletDir, chainIdString);
  saveStore(storePath, JSON.stringify(accounts), password, saltRef);
}

export function makePublicAccountsStorage(walletDir: string, mnemonic: string, password: string, chainIdString: string): PublicAccountsStorage {
  const storePath = accountsStorePathForWallet(walletDir, chainIdString);
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
      savePublicAccounts(walletDir, password, chainIdString, store, { current: salt });
    },
    getAccount: (index: number) => {
      if (store.nextIndex <= index) {
        return null;
      }
      return store.accounts[index];
    },
    generateNextIndex: () => {
      const index = store.nextIndex++;
      const priv = Mnemonic.to0xPrivateKeyByIndex(mnemonic, index);
      const address = ethers.computeAddress(priv);
      const acct: PublicAccount = {
        address,
        index,
        priv,
        tags: [],
        lastUpdated: 0,
        ethBalance: "0",
        erc20Balances: {},
        erc721Holdings: {},
      };
      store.accounts[index] = acct;
      savePublicAccounts(walletDir, password, chainIdString, store, { current: salt });
      return acct;
    },
  };
}