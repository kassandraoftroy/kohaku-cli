import { getPublicKey } from "@noble/secp256k1";
import generateStealthMetaAddressFromKeys from "@scopelift/stealth-address-sdk/dist/utils/helpers/generateStealthMetaAddressFromKeys.js";
import { stealthChainShortName } from "eth-stealth-address-resolver";
import { bytesToHex, hexToBytes, type Hex } from "viem";
import { mnemonicToAccount } from "viem/accounts";

import {
  STEALTH_SPENDING_PATH,
  STEALTH_VIEWING_PATH,
} from "./constants.js";

export type StealthKeypair = {
  spendingPrivateKey: Hex;
  viewingPrivateKey: Hex;
  spendingPublicKey: Hex;
  viewingPublicKey: Hex;
  /** Raw concatenated compressed pubs (`0x` + spend||view without second 0x). */
  stealthMetaAddress: Hex;
  /** `st:<chain>:<stealthMetaAddress>` */
  stealthMetaAddressURI: string;
};

function privFromPath(
  mnemonic: string,
  path: typeof STEALTH_SPENDING_PATH | typeof STEALTH_VIEWING_PATH
): Hex {
  const account = mnemonicToAccount(mnemonic, { path });
  const privBytes = account.getHdKey().privateKey;
  if (!privBytes) {
    throw new Error(`Failed to derive private key at ${path}`);
  }
  return bytesToHex(privBytes);
}

/**
 * Derive the wallet's fixed stealth spending/viewing keys and meta-address URI.
 */
export function deriveStealthKeypair(
  mnemonic: string,
  chainId: bigint = 1n
): StealthKeypair {
  const spendingPrivateKey = privFromPath(mnemonic, STEALTH_SPENDING_PATH);
  const viewingPrivateKey = privFromPath(mnemonic, STEALTH_VIEWING_PATH);
  const spendingPublicKey = bytesToHex(
    getPublicKey(hexToBytes(spendingPrivateKey), true)
  ) as Hex;
  const viewingPublicKey = bytesToHex(
    getPublicKey(hexToBytes(viewingPrivateKey), true)
  ) as Hex;
  const stealthMetaAddress = generateStealthMetaAddressFromKeys({
    spendingPublicKey,
    viewingPublicKey,
  }) as Hex;
  const chain = stealthChainShortName(chainId);
  return {
    spendingPrivateKey,
    viewingPrivateKey,
    spendingPublicKey,
    viewingPublicKey,
    stealthMetaAddress,
    stealthMetaAddressURI: `st:${chain}:${stealthMetaAddress}`,
  };
}
