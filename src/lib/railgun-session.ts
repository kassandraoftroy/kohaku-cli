import type { Host } from "@kohaku-eth/plugins";

import { makeHost } from "../host/makeHost.js";
import { makePublicClient, disposePublicClient, type KohakuPublicClient } from "../utils/rpc.js";
import { createProtocolPlugin, type AnyPlugin } from "../utils/plugins.js";

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
 * One Rust Railgun wallet and encrypted checkpoint per wallet/chain in this process.
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
      rpcUrl: opts.rpcUrl,
      walletDir: opts.walletDir,
      password: opts.password,
      mnemonic: opts.mnemonic,
      pluginId: "rg-v2",
      chainId: opts.chainId,
    });
    const plugin = await createProtocolPlugin("railgun", host, opts.chainId);
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
  (session.plugin as { close?: () => void }).close?.();
  disposePublicClient(session.rpc);
  sessions.delete(key);
}

export function disposeAllRailgunSessions(): void {
  for (const session of sessions.values()) {
    (session.plugin as { close?: () => void }).close?.();
    disposePublicClient(session.rpc);
  }
  sessions.clear();
}
