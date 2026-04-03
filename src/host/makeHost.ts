import type { Host } from "@kohaku-eth/plugins";
import { ethers as kohakuEthersProvider } from "@kohaku-eth/provider/ethers";
import type { JsonRpcProvider } from "ethers";

import { makeKeystore, makeRailgunKeystore } from "./keystore";
import { makeStorage, type PluginId } from "./storage";

export type MakeHostOptions = {
  rpc: JsonRpcProvider;
  walletDir: string;
  password: string;
  mnemonic: string;
  pluginId: PluginId;
};

function makeNetwork(): Host["network"] {
  const fetchFn: typeof fetch | undefined = globalThis.fetch;
  if (!fetchFn) {
    throw new Error(
      "global fetch is not available in this Node runtime; cannot satisfy Host.network"
    );
  }

  return {
    fetch: fetchFn.bind(globalThis),
  };
}

export async function makeHost(options: MakeHostOptions): Promise<Host> {
  const { rpc, walletDir, password, mnemonic, pluginId } = options;

  const provider = kohakuEthersProvider(rpc);

  const keystore = pluginId === "rg" ? makeRailgunKeystore(mnemonic) : makeKeystore(mnemonic);

  return {
    network: makeNetwork(),
    storage: makeStorage(walletDir, pluginId, password),
    keystore,
    provider,
  };
}
