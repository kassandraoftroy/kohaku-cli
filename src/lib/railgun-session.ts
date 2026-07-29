import type { Host } from "@kohaku-eth/plugins";
import { createRailgunPlugin } from "@kohaku-eth/railgun";

import { makeHost } from "../host/makeHost.js";
import { makePublicClient, disposePublicClient, type KohakuPublicClient } from "../utils/rpc.js";
import { railgunPluginOptions, type AnyPlugin } from "../utils/plugins.js";

export type RailgunSessionKey = `${string}:${string}`;

export function railgunSessionKey(walletDir: string, chainId: bigint): RailgunSessionKey {
  return `${walletDir}:${chainId.toString()}`;
}

type RailgunSession = {
  host: Host;
  plugin: AnyPlugin;
  rpc: KohakuPublicClient;
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

  const rpc = await makePublicClient(opts.rpcUrl);
  try {
    const host = await makeHost({
      rpc,
      walletDir: opts.walletDir,
      password: opts.password,
      mnemonic: opts.mnemonic,
      pluginId: "rg",
    });
    const plugin = (await createRailgunPlugin(
      host,
      railgunPluginOptions()
    )) as AnyPlugin;
    const session: RailgunSession = { host, plugin, rpc };
    sessions.set(key, session);
    return session;
  } catch (e) {
    disposePublicClient(rpc);
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
  disposePublicClient(session.rpc);
  sessions.delete(key);
}

export function disposeAllRailgunSessions(): void {
  for (const session of sessions.values()) {
    disposePublicClient(session.rpc);
  }
  sessions.clear();
}
