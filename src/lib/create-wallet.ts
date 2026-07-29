import { existsSync, mkdirSync } from "node:fs";

import { isAddressUsed } from "../utils/address-used.js";
import {
  generateMnemonic,
  normalizeValidatedMnemonic,
  peekAddressesFromMnemonic,
  writeSeedKeystore,
} from "../utils/mnemonic.js";
import { makePublicClient, disposePublicClient } from "../utils/rpc.js";
import { makePublicAccountsStorage } from "../utils/public-accounts.js";
import {
  resolveWalletDir,
  writeWalletType,
} from "../utils/wallets-util.js";

export async function findLastTouchedPublicIndex(
  mnemonic: string,
  rpcUrl: string
): Promise<number> {
  const client = await makePublicClient(rpcUrl);
  try {
    let start = 0;
    let lastTouched = -1;
    const WINDOW_SIZE = 10;

    for (;;) {
      const indexes = Array.from({ length: WINDOW_SIZE }, (_, i) => start + i);
      const addresses = peekAddressesFromMnemonic(mnemonic, indexes);
      const touched = await Promise.all(
        addresses.map((address) => isAddressUsed(address, client))
      );

      for (let i = 0; i < touched.length; i += 1) {
        if (touched[i]) {
          lastTouched = indexes[i]!;
        }
      }

      if (!touched.some(Boolean)) {
        return lastTouched;
      }
      start += WINDOW_SIZE;
    }
  } finally {
    disposePublicClient(client);
  }
}

export type CreateWalletOnDiskInput = {
  dataDir: string;
  walletName: string;
  mnemonic: string;
  password: string;
  testnet: boolean;
  /** When set, verifies RPC chain id and scans used public indices (import flow). */
  rpcUrl?: string;
};

export async function createWalletOnDisk(
  input: CreateWalletOnDiskInput
): Promise<{ walletDir: string; mnemonic: string }> {
  const walletDir = resolveWalletDir(input.dataDir, input.walletName);
  if (existsSync(walletDir)) {
    throw new Error(`A wallet named "${input.walletName}" already exists.`);
  }

  const mnemonicPhrase = normalizeValidatedMnemonic(input.mnemonic);
  const expectedChainId = input.testnet ? 11155111n : 1n;

  let lastTouchedIndex = -1;
  if (input.rpcUrl) {
    const client = await makePublicClient(input.rpcUrl);
    try {
      const chainId = BigInt(await client.getChainId());
      if (chainId !== expectedChainId) {
        throw new Error(
          `RPC chain ID ${chainId.toString()} does not match expected ${expectedChainId.toString()} for this wallet.`
        );
      }
    } finally {
      disposePublicClient(client);
    }
    lastTouchedIndex = await findLastTouchedPublicIndex(mnemonicPhrase, input.rpcUrl);
  }

  mkdirSync(walletDir, { recursive: true });
  writeSeedKeystore(mnemonicPhrase, input.password, walletDir);
  writeWalletType(input.testnet ? "testnet" : "mainnet", walletDir);

  if (input.rpcUrl && lastTouchedIndex >= 0) {
    const publicAccountsStorage = makePublicAccountsStorage(
      walletDir,
      mnemonicPhrase,
      input.password
    );
    publicAccountsStorage.addNextAccounts(lastTouchedIndex + 1);
  }

  return { walletDir, mnemonic: mnemonicPhrase };
}

export { generateMnemonic };
