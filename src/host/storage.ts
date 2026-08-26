import { join } from "node:path";
import type { Storage } from "@kohaku-eth/plugins";
import { loadStore, saveStore } from "../utils/aes-storage";

export type PluginId = "rg" | "ppv1" | "tc";

export function pluginStorePathForWallet(
  walletDir: string,
  pluginId: PluginId
): string {
  return join(walletDir, `${pluginId}-storage.json`);
}

export function makeStorage(
  walletDir: string,
  pluginId: PluginId,
  password: string
): Storage {
  if (!password) {
    throw new Error("Password cannot be empty");
  }
  const storePath = pluginStorePathForWallet(walletDir, pluginId);
  const { store: initial, salt } = loadStore(storePath, password);
  const initialStore = JSON.parse(initial);
  const saltRef = { current: salt };
  const store: Record<string, string> = { ...initialStore };

  return {
    _brand: "Storage" as const,
    async get(key: string): Promise<string | null> {
      return store[key] ?? null;
    },
    async set(key: string, value: string): Promise<void> {
      store[key] = value;
      saveStore(storePath, JSON.stringify(store), password, saltRef);
    },
  };
}
