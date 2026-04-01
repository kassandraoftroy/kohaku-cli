import { deriveRailgunKey, Mnemonic } from "derive-railgun-keys";
import type { Hex } from "ox/Hex";
import type { Keystore } from "@kohaku-eth/plugins";

export function makeRailgunKeystore(mnemonic: string): Keystore {
  return {
    deriveAt(path: string): Hex {
      return `0x${deriveRailgunKey(mnemonic, path)}`;
    },
  };
}

export function makeKeystore(mnemonic: string): Keystore {
  return {
    deriveAt(path: string): Hex {
      return Mnemonic.to0xPrivateKey(mnemonic, path);
    },
  };
}