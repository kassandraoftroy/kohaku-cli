import { join } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import type { Storage } from "@kohaku-eth/plugins";
import { loadStore, saveStore } from "../utils/aes-storage";

/** Compression stays inside the existing authenticated encrypted envelope. */
type StoredValue = string | { codec: "kohaku-gzip-v1"; data: string };
const COMPRESS_ABOVE = 64 * 1024;

function encodeValue(value: string): StoredValue {
  if (value.length < COMPRESS_ABOVE) return value;
  return { codec: "kohaku-gzip-v1", data: gzipSync(value).toString("base64") };
}

function decodeValue(value: StoredValue): string {
  if (typeof value === "string") return value;
  if (value?.codec !== "kohaku-gzip-v1" || typeof value.data !== "string") {
    throw new Error("Invalid compressed plugin storage entry");
  }
  return gunzipSync(Buffer.from(value.data, "base64")).toString("utf8");
}

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
  // SDKs hand us one serialized state per derivation. Combining two mainnet
  // Tornado states and then base64-encoding their ciphertext can exceed V8's
  // string limit. Compress entries individually before building the outer JSON.
  // Existing raw-string entries are migrated in memory; the original file is
  // retained until a normal successful write.
  const store: Record<string, StoredValue> = Object.fromEntries(
    Object.entries(initialStore as Record<string, StoredValue>).map(([key, value]) => [
      key, typeof value === "string" ? encodeValue(value) : value,
    ])
  );

  return {
    _brand: "Storage" as const,
    async get(key: string): Promise<string | null> {
      const value = store[key];
      return value === undefined ? null : decodeValue(value);
    },
    async set(key: string, value: string): Promise<void> {
      const previous = store[key];
      store[key] = encodeValue(value);
      try {
        saveStore(storePath, JSON.stringify(store), password, saltRef);
      } catch (error) {
        if (previous === undefined) delete store[key];
        else store[key] = previous;
        throw error;
      }
    },
  };
}
