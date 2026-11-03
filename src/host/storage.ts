import { join } from "node:path";
import { createHash } from "node:crypto";
import { gzip, gunzip } from "node:zlib";
import { promisify } from "node:util";
import type { Storage } from "@kohaku-eth/plugins";
import { loadStore, saveStore } from "../utils/aes-storage";

/** Compression stays inside the existing authenticated encrypted envelope. */
type StoredValue = string | { codec: "kohaku-gzip-v1"; data: string };
const COMPRESS_ABOVE = 64 * 1024;
const compress = promisify(gzip);
const decompress = promisify(gunzip);

async function encodeValue(value: string): Promise<StoredValue> {
  if (value.length < COMPRESS_ABOVE) return value;
  return { codec: "kohaku-gzip-v1", data: (await compress(value)).toString("base64") };
}

async function decodeValue(value: StoredValue): Promise<string> {
  if (typeof value === "string") return value;
  if (value?.codec !== "kohaku-gzip-v1" || typeof value.data !== "string") {
    throw new Error("Invalid compressed plugin storage entry");
  }
  return (await decompress(Buffer.from(value.data, "base64"))).toString("utf8");
}

export type PluginId = "rg" | "rg-v2" | "ppv1" | "tc";

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
  const store: Record<string, StoredValue> = {};
  const ready = Promise.all(Object.entries(initialStore as Record<string, StoredValue>).map(async ([key, value]) => {
    store[key] = typeof value === "string" ? await encodeValue(value) : value;
  })).then(() => {});
  // Compression runs in libuv workers; keep writes ordered and rollbacks local
  // so concurrent SDK callbacks cannot overwrite each other's state.
  let writes = ready;
  const hashes = new Map<string, string>();
  const digest = (value: string) => createHash("sha256").update(value).digest("hex");

  return {
    _brand: "Storage" as const,
    async get(key: string): Promise<string | null> {
      await ready;
      await writes;
      const value = store[key];
      if (value === undefined) return null;
      const decoded = await decodeValue(value);
      // A later read must not replace the digest of an intervening write.
      if (store[key] === value) hashes.set(key, digest(decoded));
      return decoded;
    },
    async set(key: string, value: string): Promise<void> {
      const write = writes.then(async () => {
        await ready;
        const hash = digest(value);
        if (hashes.get(key) === hash) return;
        const encoded = await encodeValue(value);
        const previous = store[key];
        store[key] = encoded;
        try {
          saveStore(storePath, JSON.stringify(store), password, saltRef);
          hashes.set(key, hash);
        } catch (error) {
          if (previous === undefined) delete store[key];
          else store[key] = previous;
          throw error;
        }
      });
      writes = write.catch(() => {});
      return write;
    },
  };
}
