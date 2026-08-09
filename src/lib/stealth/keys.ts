import { getPublicKey } from "@noble/secp256k1";
import generateStealthMetaAddressFromKeys from "@scopelift/stealth-address-sdk/dist/utils/helpers/generateStealthMetaAddressFromKeys.js";
import { bytesToHex, hexToBytes, type Hex } from "viem";
import { mnemonicToAccount } from "viem/accounts";

import {
  STEALTH_SPENDING_PATH,
  STEALTH_VIEWING_PATH,
  stealthChainShortName,
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

/** True if value looks like a stealth meta-address URI or bare 0x meta (spending||viewing pubs). */
export function looksLikeStealthMetaAddress(value: string): boolean {
  const v = value.trim();
  if (/^st:[a-z0-9]+:0x[0-9a-fA-F]+$/i.test(v)) return true;
  // scheme-1 meta = two compressed pubs = 132 hex chars + 0x prefix.
  if (/^0x[0-9a-fA-F]{132}$/.test(v)) return true;
  return false;
}

export function normalizeStealthMetaAddressURI(
  value: string,
  chainId: bigint = 1n
): string {
  const v = value.trim();
  if (/^st:[a-z0-9]+:0x/i.test(v)) return v;
  if (/^0x[0-9a-fA-F]{132}$/.test(v)) {
    return `st:${stealthChainShortName(chainId)}:${v}`;
  }
  throw new Error(
    `Not a stealth meta-address (expected st:<chain>:0x… or 0x + 132 hex chars): ${v.slice(0, 24)}…`
  );
}
