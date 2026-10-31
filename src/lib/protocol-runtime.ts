import type { Host } from "@kohaku-eth/plugins";

import { makeHost } from "../host/makeHost.js";
import { makePublicClient, disposePublicClient, type KohakuPublicClient } from "../utils/rpc.js";
import { runWithWalletTrafficLog } from "../utils/tor.js";
import {
  createSchemedPlugins,
  pluginIdForProtocol,
  type SchemedPlugins,
  type SupportedProtocol,
} from "../utils/plugins.js";
import { acquireRailgunSession } from "./railgun-session.js";

export type ProtocolRuntimeContext = {
  protocol: SupportedProtocol;
  rpcUrl: string;
  walletDir: string;
  password: string;
  mnemonic: string;
  chainId: bigint;
};

/**
 * Runs `fn` with a protocol host and both derivation plugins. Railgun reuses
 * one session per wallet/chain (both fields are that plugin). Tornado and
 * Privacy Pools open a legacy plugin on the existing storage keys and a
 * signature plugin on prefixed keys.
 */
export async function withProtocolRuntime<T>(
  ctx: ProtocolRuntimeContext,
  fn: (host: Host, plugins: SchemedPlugins) => Promise<T>
): Promise<T> {
  return runWithWalletTrafficLog(ctx.walletDir, async () => {
    if (ctx.protocol === "railgun") {
      const { host, plugin } = await acquireRailgunSession({
        rpcUrl: ctx.rpcUrl,
        walletDir: ctx.walletDir,
        password: ctx.password,
        mnemonic: ctx.mnemonic,
        chainId: ctx.chainId,
      });
      return fn(host, { legacy: plugin, signature: plugin });
    }

    const rpc = await makePublicClient(ctx.rpcUrl);
    try {
      const host = await makeHost({
        rpc,
        rpcUrl: ctx.rpcUrl,
        walletDir: ctx.walletDir,
        password: ctx.password,
        mnemonic: ctx.mnemonic,
        pluginId: pluginIdForProtocol(ctx.protocol),
        chainId: ctx.chainId,
      });
      const plugins = await createSchemedPlugins(ctx.protocol, host, ctx.chainId);
      return await fn(host, plugins);
    } finally {
      disposePublicClient(rpc);
    }
  });
}

/** Public-chain RPC for approvals / sends; reuses the Railgun session provider when active. */
export async function rpcForWalletOps(
  ctx: ProtocolRuntimeContext
): Promise<{ rpc: KohakuPublicClient; dispose: () => void }> {
  if (ctx.protocol === "railgun") {
    const session = await acquireRailgunSession(ctx);
    return { rpc: session.rpc, dispose: () => {} };
  }
  const rpc = await makePublicClient(ctx.rpcUrl);
  return { rpc, dispose: () => disposePublicClient(rpc) };
}
