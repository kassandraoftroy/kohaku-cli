import { existsSync, mkdirSync } from "node:fs";

import { isAddressUsed } from "../utils/address-used.js";
import {
  generateMnemonic,
  normalizeValidatedMnemonic,
  peekAddressesFromMnemonic,
  writeSeedKeystore,
} from "../utils/mnemonic.js";
import {
  makePublicClient,
  disposePublicClient,
  fetchCurrentBlockNumber,
} from "../utils/rpc.js";
import { makePublicAccountsStorage } from "../utils/public-accounts.js";
import {
  resolveWalletDir,
  writeWalletType,
} from "../utils/wallets-util.js";
import { defaultStealthImportStartBlock } from "./stealth/constants.js";
import {
  parseStealthStartBlock,
  resolveStealthScanFloor,
} from "./stealth/scan.js";
import { writeStealthStartBlock } from "./stealth/start-block-file.js";

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
  /** True when restoring an existing mnemonic (`create-wallet --import`). */
  importMode: boolean;
  /**
   * Required for import (used address scan).
   * Optional for new seeds: preferred RPC when recording `.stealth-start-block`.
   */
  rpcUrl?: string;
  /**
   * Import only: persist as `.stealth-start-block` for later `balances` scans.
   * When omitted, records the current chain tip (same as a new wallet). The
   * command layer passes the Kohaku-schema floor when the user gives a bare
   * `--stealth-start-block`, or an explicit block when they pass a number.
   */
  stealthStartBlock?: bigint;
};

/**
 * Interpret `create-wallet --import --stealth-start-block [block]`.
 * Omitted → undefined (caller writes the chain tip). Bare flag → Kohaku floor.
 * Explicit `n` is rounded up to the ERC-5564 announcer deploy block when below it.
 */
export function interpretImportStealthStartBlockFlag(
  flag: string | true | undefined,
  chainId: bigint
): bigint | undefined {
  if (flag === undefined) return undefined;
  if (flag === true || flag === "") {
    return defaultStealthImportStartBlock(chainId);
  }
  return resolveStealthScanFloor({
    chainId,
    startFromBlock: parseStealthStartBlock(flag),
  });
}

export async function createWalletOnDisk(
  input: CreateWalletOnDiskInput
): Promise<{
  walletDir: string;
  mnemonic: string;
  stealthStartBlockWritten?: bigint;
}> {
  const walletDir = resolveWalletDir(input.dataDir, input.walletName);
  if (existsSync(walletDir)) {
    throw new Error(`A wallet named "${input.walletName}" already exists.`);
  }

  const mnemonicPhrase = normalizeValidatedMnemonic(input.mnemonic);
  const expectedChainId = input.testnet ? 11155111n : 1n;

  if (input.importMode && !input.rpcUrl?.trim()) {
    throw new Error("rpcUrl is required when importMode is true.");
  }
  if (!input.importMode && input.stealthStartBlock !== undefined) {
    throw new Error(
      "stealthStartBlock is only valid for import; new wallets use the current chain tip."
    );
  }

  let lastTouchedIndex = -1;
  if (input.importMode) {
    const client = await makePublicClient(input.rpcUrl!);
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
    lastTouchedIndex = await findLastTouchedPublicIndex(
      mnemonicPhrase,
      input.rpcUrl!
    );
  }

  mkdirSync(walletDir, { recursive: true });
  writeSeedKeystore(mnemonicPhrase, input.password, walletDir);
  writeWalletType(input.testnet ? "testnet" : "mainnet", walletDir);

  let stealthStartBlockWritten: bigint | undefined;
  if (input.stealthStartBlock !== undefined) {
    const block = resolveStealthScanFloor({
      chainId: expectedChainId,
      startFromBlock: input.stealthStartBlock,
    });
    writeStealthStartBlock(walletDir, block);
    stealthStartBlockWritten = block;
  } else {
    const { blockNumber } = await fetchCurrentBlockNumber({
      testnet: input.testnet,
      rpcUrl: input.rpcUrl,
    });
    writeStealthStartBlock(walletDir, blockNumber);
    stealthStartBlockWritten = blockNumber;
  }

  if (input.importMode && lastTouchedIndex >= 0) {
    const publicAccountsStorage = makePublicAccountsStorage(
      walletDir,
      mnemonicPhrase,
      input.password
    );
    publicAccountsStorage.addNextAccounts(lastTouchedIndex + 1);
  }

  return {
    walletDir,
    mnemonic: mnemonicPhrase,
    stealthStartBlockWritten,
  };
}

export { generateMnemonic };
