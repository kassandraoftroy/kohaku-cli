import { deriveRailgunKey, Mnemonic } from "derive-railgun-keys";
import type { Hex } from "ox/Hex";
import type { Keystore } from "@kohaku-eth/plugins";

export function makeRailgunKeystore(mnemonic: string): Keystore {
  return {
    async deriveAt(path: string): Promise<Hex> {
      return `0x${deriveRailgunKey(mnemonic, path)}`;
    },
  };
}

export function makeKeystore(mnemonic: string): Keystore {
  return {
    async deriveAt(path: string): Promise<Hex> {
      return Mnemonic.to0xPrivateKey(mnemonic, path);
    },
  };
}