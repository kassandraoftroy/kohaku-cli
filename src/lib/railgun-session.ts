import type { Host } from "@kohaku-eth/plugins";
import type { JsonRpcProvider } from "ethers";
import { createRailgunPlugin } from "@kohaku-eth/railgun";

import { makeHost } from "../host/makeHost.js";
import { makeEthersProvider } from "../utils/rpc.js";
import type { AnyPlugin } from "../utils/plugins.js";

export type RailgunSessionKey = `${string}:${string}`;

export function railgunSessionKey(walletDir: string, chainId: bigint): RailgunSessionKey {
  return `${walletDir}:${chainId.toString()}`;
}

type RailgunSession = {
  host: Host;
  plugin: AnyPlugin;
  rpc: JsonRpcProvider;
};

const sessions = new Map<RailgunSessionKey, RailgunSession>();

/**
 * One Railgun plugin + host per wallet/chain in this process.
 * Avoids repeated `createRailgunPlugin()` → `initLogging()` (WASM global, single-use).
 */
export async function acquireRailgunSession(opts: {
  rpcUrl: string;
  walletDir: string;
  password: string;
  mnemonic: string;
  chainId: bigint;
}): Promise<RailgunSession> {
  const key = railgunSessionKey(opts.walletDir, opts.chainId);
  const existing = sessions.get(key);
  if (existing) {
    return existing;
  }

  const rpc = await makeEthersProvider(opts.rpcUrl);
  try {
    const host = await makeHost({
      rpc,
      walletDir: opts.walletDir,
      password: opts.password,
      mnemonic: opts.mnemonic,
      pluginId: "rg",
    });
    const plugin = (await createRailgunPlugin(host, {
      rpcBatchSize: 450,
    })) as AnyPlugin;
    const session: RailgunSession = { host, plugin, rpc };
    sessions.set(key, session);
    return session;
  } catch (e) {
    rpc.destroy();
    throw e;
  }
}

export function getRailgunSession(
  walletDir: string,
  chainId: bigint
): RailgunSession | undefined {
  return sessions.get(railgunSessionKey(walletDir, chainId));
}

export function disposeRailgunSession(walletDir: string, chainId: bigint): void {
  const key = railgunSessionKey(walletDir, chainId);
  const session = sessions.get(key);
  if (!session) return;
  session.rpc.destroy();
  sessions.delete(key);
}

export function disposeAllRailgunSessions(): void {
  for (const session of sessions.values()) {
    session.rpc.destroy();
  }
  sessions.clear();
}
