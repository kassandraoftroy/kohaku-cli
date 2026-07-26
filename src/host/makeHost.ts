import type { Host } from "@kohaku-eth/plugins";
import { ethers as kohakuEthersProvider } from "@kohaku-eth/provider/ethers";
import type { JsonRpcProvider } from "ethers";

import { withChunkedGetLogs, withTransactionCount } from "./chunked-get-logs";
import { makeKeystore, makeRailgunKeystore } from "./keystore";
import { makeStorage, type PluginId } from "./storage";
import { tornadoExternalSyncForChain } from "../utils/saga-external-sync";
import { kohakuFetch } from "../utils/tor";

export type MakeHostOptions = {
  rpc: JsonRpcProvider;
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
    withTransactionCount(kohakuEthersProvider(rpc))
  );

  const keystore = pluginId === "rg" ? makeRailgunKeystore(mnemonic) : makeKeystore(mnemonic);
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
