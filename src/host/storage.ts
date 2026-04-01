import { join } from "node:path";
import type { Storage } from "@kohaku-eth/plugins";
import { loadStore, saveStore } from "../utils/aes-storage";

export type PluginId = "rg" | "tc" | "ppv1";

function pluginStorePathForWallet(walletDir: string, pluginId: PluginId, chainIdString: string): string {
  return join(walletDir, `${pluginId}-${chainIdString}-storage.json`);
}

export function makeStorage(
  walletDir: string,
  pluginId: PluginId,
  chainIdString: string,
  password: string
): Storage {
  if (!password) {
    throw new Error("Password cannot be empty");
  }
  const storePath = pluginStorePathForWallet(walletDir, pluginId, chainIdString);
  const { store: initial, salt } = loadStore(storePath, password);
  const initialStore = JSON.parse(initial);
  const saltRef = { current: salt };
  const store: Record<string, string> = { ...initialStore };

  return {
    _brand: "Storage" as const,
    get(key: string): string | null {
      return store[key] ?? null;
    },
    set(key: string, value: string): void {
      store[key] = value;
      saveStore(storePath, JSON.stringify(store), password, saltRef);
    },
  };
}
