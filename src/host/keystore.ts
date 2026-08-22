import { deriveRailgunKey, Mnemonic } from "derive-railgun-keys";
import type { Hex } from "ox/Hex";
import type { Keystore } from "@kohaku-eth/plugins";

import { parseStealthDelegatorPath } from "../lib/stealth/constants.js";
import { formatStealthSelector } from "../lib/stealth/storage.js";

export function makeRailgunKeystore(mnemonic: string): Keystore {
  return {
    async deriveAt(path: string): Promise<Hex> {
      return `0x${deriveRailgunKey(mnemonic, path)}`;
    },
  };
}

function asHexPriv(priv: string): Hex {
  return (priv.startsWith("0x") ? priv : `0x${priv}`) as Hex;
}

/** Look up a stored payment stealth private key by local `sN` index. */
export type StealthDelegatorPrivLookup = (
  stealthIndex: number
) => string | null;

export function makeKeystore(
  mnemonic: string,
  opts?: { stealthDelegatorPriv?: StealthDelegatorPrivLookup }
): Keystore {
  return {
    async deriveAt(path: string): Promise<Hex> {
      const stealthIndex = parseStealthDelegatorPath(path);
      if (stealthIndex !== null) {
        const priv = opts?.stealthDelegatorPriv?.(stealthIndex) ?? null;
        if (!priv) {
          throw new Error(
            `Stealth account ${formatStealthSelector(stealthIndex)} not found in this wallet.`
          );
        }
        return asHexPriv(priv);
      }
      return Mnemonic.to0xPrivateKey(mnemonic, path);
    },
  };
}
