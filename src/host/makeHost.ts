import type { Host } from "@kohaku-eth/plugins";
import { viem as kohakuViemProvider } from "@kohaku-eth/provider/viem";

import { withChunkedGetLogs, withTransactionCount } from "./chunked-get-logs";
import { makeKeystore, makeRailgunKeystore } from "./keystore";
import { makeStealthAccountsStorage } from "../lib/stealth/storage";
import { makeStorage, type PluginId } from "./storage";
import { tornadoExternalSyncForChain } from "../utils/saga-external-sync";
import { kohakuFetch } from "../utils/tor";
import type { KohakuPublicClient } from "../utils/rpc.js";

export type MakeHostOptions = {
  rpc: KohakuPublicClient;
  walletDir: string;
  password: string;
  mnemonic: string;
  pluginId: PluginId;
  chainId?: bigint;
  externalSyncProvider?: Host["externalSyncProvider"];
};

function makeNetwork(): Host["network"] {
  if (typeof globalThis.fetch !== "function") {
    throw new Error(
      "global fetch is not available in this Node runtime; cannot satisfy Host.network"
    );
  }

  // Always use kohakuFetch so an active Tor session is picked up dynamically
  // (Host may be created before or during withTor).
  return {
    fetch: kohakuFetch,
  };
}

export async function makeHost(options: MakeHostOptions): Promise<Host> {
  const {
    rpc,
    walletDir,
    password,
    mnemonic,
    pluginId,
    chainId,
    externalSyncProvider: externalSyncProviderIn,
  } = options;

  const provider = withChunkedGetLogs(
    withTransactionCount(kohakuViemProvider(rpc))
  );

  const stealthStorage = makeStealthAccountsStorage(walletDir, password);
  const keystore =
    pluginId === "rg"
      ? makeRailgunKeystore(mnemonic)
      : makeKeystore(mnemonic, {
          stealthDelegatorPriv: (stealthIndex) =>
            stealthStorage.getAccount(stealthIndex)?.priv ?? null,
        });
  const network = makeNetwork();
  const externalSyncProvider =
    externalSyncProviderIn ??
    (pluginId === "tc" && chainId != null
      ? tornadoExternalSyncForChain(chainId, network)
      : undefined);

  return {
    network,
    storage: makeStorage(walletDir, pluginId, password),
    keystore,
    provider,
    ...(externalSyncProvider ? { externalSyncProvider } : {}),
  };
}
