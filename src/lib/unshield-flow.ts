import { createPPv1Broadcaster } from "@kohaku-eth/privacy-pools";
import type { AssetAmount, Host } from "@kohaku-eth/plugins";
import { formatUnits, getAddress, parseUnits } from "ethers";

import { makeHost } from "../host/makeHost";
import {
  makeEthersProvider,
  railgunPimlicoBundlerUrl,
} from "../utils/rpc";
import type { ResolvedTokenMeta } from "../utils/tokens-util";
import { wethAddressForChain } from "../utils/tokens-util";
import {
  ETH_AS_ERC20,
  PRIVACY_POOLS_BROADCASTER_URL,
  configureRailgunForUnshield,
  createProtocolPlugin,
  pluginIdForProtocol,
  railgunNativeEthAssetAmount,
  type SupportedProtocol,
} from "../utils/plugins";

type PpNoteForMax = { balance: bigint; assetAddress: bigint | string };

function ppNoteAssetLower(n: PpNoteForMax): string {
  if (typeof n.assetAddress === "bigint") {
    return `0x${n.assetAddress.toString(16).padStart(40, "0")}`.toLowerCase();
  }
  return String(n.assetAddress).toLowerCase();
}

export async function maxUnshieldAmountHint(
  protocol: SupportedProtocol,
  plugin: unknown,
  tokenMeta: ResolvedTokenMeta,
  chainId: bigint
): Promise<{ cap: bigint; privacyPoolsLargestNote: boolean }> {
  if (protocol === "privacy-pools") {
    const targetAddr = tokenMeta.isEth
      ? ETH_AS_ERC20.toLowerCase()
      : tokenMeta.tokenAddress.toLowerCase();
    let largest = 0n;
    try {
      const notes = await (
        plugin as unknown as {
          notes: (assets?: unknown[], includeSpent?: boolean) => Promise<PpNoteForMax[]>;
        }
      ).notes(undefined, false);
      for (const n of notes) {
        if (ppNoteAssetLower(n) !== targetAddr || n.balance <= 0n) continue;
        if (n.balance > largest) largest = n.balance;
      }
    } catch {
      // ignore
    }
    return { cap: largest, privacyPoolsLargestNote: true };
  }

  let targetAddr = tokenMeta.tokenAddress.toLowerCase();
  if (tokenMeta.isEth) {
    const weth = wethAddressForChain(chainId);
    targetAddr = weth ? weth.toLowerCase() : ETH_AS_ERC20.toLowerCase();
  }

  let sum = 0n;
  try {
    const balances: AssetAmount[] = await (
      plugin as unknown as { balance: (a: unknown) => Promise<AssetAmount[]> }
    ).balance(undefined);
    for (const row of balances) {
      const asset = row.asset as { __type?: string; contract?: unknown } | undefined;
      if (!asset || asset.__type !== "erc20") continue;
      let addr: string;
      if (typeof asset.contract === "string") addr = asset.contract.toLowerCase();
      else if (typeof asset.contract === "bigint")
        addr = `0x${asset.contract.toString(16).padStart(40, "0")}`;
      else continue;
      if (addr === targetAddr) sum += row.amount;
    }
  } catch {
    // ignore
  }
  return { cap: sum, privacyPoolsLargestNote: false };
}

export async function broadcastPreparedPrivateOp(
  protocol: SupportedProtocol,
  host: Host,
  plugin: unknown,
  operation: unknown
): Promise<unknown> {
  if (protocol === "railgun") {
    await (plugin as { broadcast: (op: unknown) => Promise<void> }).broadcast(operation);
    return undefined;
  }
  const broadcaster = createPPv1Broadcaster(host, {
    broadcasterUrl: PRIVACY_POOLS_BROADCASTER_URL,
  });
  return await broadcaster.broadcast(operation as never);
}

export type UnshieldPrepared = {
  privateOp: unknown;
  amount: bigint;
  recipient: `0x${string}`;
};

export async function prepareUnshieldOperation(opts: {
  protocol: SupportedProtocol;
  rpcUrl: string;
  walletDir: string;
  password: string;
  mnemonic: string;
  chainId: bigint;
  tokenMeta: ResolvedTokenMeta;
  amount: bigint;
  recipient: `0x${string}`;
  recipientPriv?: `0x${string}`;
  onStatus?: (message: string) => void;
}): Promise<UnshieldPrepared> {
  const rpc = await makeEthersProvider(opts.rpcUrl);
  try {
    const host = await makeHost({
      rpc,
      walletDir: opts.walletDir,
      password: opts.password,
      mnemonic: opts.mnemonic,
      pluginId: pluginIdForProtocol(opts.protocol),
    });
    const plugin = await createProtocolPlugin(opts.protocol, host, opts.chainId);

    if (opts.protocol === "railgun") {
      if (!opts.recipientPriv) {
        throw new Error(
          "Railgun unshield requires a recipient public account from this wallet."
        );
      }
      configureRailgunForUnshield(
        plugin,
        opts.recipientPriv,
        railgunPimlicoBundlerUrl(opts.chainId)
      );
    }

    if (
      opts.protocol === "privacy-pools" &&
      "sync" in plugin &&
      typeof plugin.sync === "function"
    ) {
      opts.onStatus?.("Syncing private state…");
      await (plugin as { sync: () => Promise<void> }).sync.call(plugin);
    }

    const isRailgunEth = opts.protocol === "railgun" && opts.tokenMeta.isEth;
    const asset =
      isRailgunEth
        ? railgunNativeEthAssetAmount(opts.chainId, opts.amount)
        : {
            asset: {
              __type: "erc20" as const,
              contract: (opts.tokenMeta.isEth
                ? ETH_AS_ERC20
                : opts.tokenMeta.tokenAddress) as `0x${string}`,
            },
            amount: opts.amount,
          };

    opts.onStatus?.(
      opts.protocol === "railgun"
        ? "Building Railgun unshield…"
        : "Building Privacy Pools unshield…"
    );

    const prepareUnshield = (
      plugin as unknown as {
        prepareUnshield: (a: AssetAmount, t: `0x${string}`) => Promise<unknown>;
      }
    ).prepareUnshield.bind(plugin);

    const privateOp = await prepareUnshield(asset as AssetAmount, opts.recipient);
    return {
      privateOp,
      amount: opts.amount,
      recipient: getAddress(opts.recipient) as `0x${string}`,
    };
  } finally {
    rpc.destroy();
  }
}

export async function broadcastUnshield(opts: {
  protocol: SupportedProtocol;
  rpcUrl: string;
  walletDir: string;
  password: string;
  mnemonic: string;
  chainId: bigint;
  tokenMeta: ResolvedTokenMeta;
  amount: bigint;
  recipient: `0x${string}`;
  recipientPriv?: `0x${string}`;
  onStatus?: (message: string) => void;
}): Promise<unknown> {
  const rpc = await makeEthersProvider(opts.rpcUrl);
  try {
    const host = await makeHost({
      rpc,
      walletDir: opts.walletDir,
      password: opts.password,
      mnemonic: opts.mnemonic,
      pluginId: pluginIdForProtocol(opts.protocol),
    });
    const plugin = await createProtocolPlugin(opts.protocol, host, opts.chainId);

    if (opts.protocol === "railgun") {
      if (!opts.recipientPriv) {
        throw new Error(
          "Railgun unshield requires a recipient public account from this wallet."
        );
      }
      configureRailgunForUnshield(
        plugin,
        opts.recipientPriv,
        railgunPimlicoBundlerUrl(opts.chainId)
      );
    }

    if (
      opts.protocol === "privacy-pools" &&
      "sync" in plugin &&
      typeof plugin.sync === "function"
    ) {
      opts.onStatus?.("Syncing private state…");
      await (plugin as { sync: () => Promise<void> }).sync.call(plugin);
    }

    const isRailgunEth = opts.protocol === "railgun" && opts.tokenMeta.isEth;
    const asset =
      isRailgunEth
        ? railgunNativeEthAssetAmount(opts.chainId, opts.amount)
        : {
            asset: {
              __type: "erc20" as const,
              contract: (opts.tokenMeta.isEth
                ? ETH_AS_ERC20
                : opts.tokenMeta.tokenAddress) as `0x${string}`,
            },
            amount: opts.amount,
          };

    const prepareUnshield = (
      plugin as unknown as {
        prepareUnshield: (a: AssetAmount, t: `0x${string}`) => Promise<unknown>;
      }
    ).prepareUnshield.bind(plugin);

    opts.onStatus?.("Preparing unshield…");
    const privateOp = await prepareUnshield(asset as AssetAmount, opts.recipient);

    opts.onStatus?.("Broadcasting unshield…");
    return await broadcastPreparedPrivateOp(opts.protocol, host, plugin, privateOp);
  } finally {
    rpc.destroy();
  }
}

export function parseUnshieldAmount(
  raw: string,
  decimals: number,
  maxAmountHint: bigint
): bigint {
  const parsed = parseUnits(raw.trim(), decimals);
  if (parsed <= 0n) {
    throw new Error("Amount must be greater than zero.");
  }
  if (maxAmountHint > 0n && parsed > maxAmountHint) {
    throw new Error(
      `Amount exceeds maximum (${formatUnits(maxAmountHint, decimals)}).`
    );
  }
  return parsed;
}
