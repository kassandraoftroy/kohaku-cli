import { createPPv1Broadcaster } from "@kohaku-eth/privacy-pools";
import type { AssetAmount, Host } from "@kohaku-eth/plugins";
import { formatUnits, getAddress, parseUnits } from "ethers";

import { railgunPimlicoBundlerUrl } from "../utils/rpc.js";
import type { ResolvedTokenMeta } from "../utils/tokens-util.js";
import { wethAddressForChain } from "../utils/tokens-util.js";
import {
  ETH_AS_ERC20,
  PRIVACY_POOLS_BROADCASTER_URL,
  configureRailgunForUnshield,
  railgunNativeEthAssetAmount,
  type SupportedProtocol,
} from "../utils/plugins.js";
import { withProtocolRuntime } from "./protocol-runtime.js";

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

type UnshieldRuntimeOpts = {
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
};

async function runUnshieldWithPlugin(
  opts: UnshieldRuntimeOpts,
  host: Host,
  plugin: unknown,
  mode: "prepare" | "broadcast"
): Promise<UnshieldPrepared | unknown> {
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

  const maybeSync = plugin as { sync?: () => Promise<void> };
  if (opts.protocol === "privacy-pools" && typeof maybeSync.sync === "function") {
    opts.onStatus?.("Syncing private state…");
    await maybeSync.sync.call(plugin);
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

  opts.onStatus?.(
    mode === "broadcast"
      ? "Preparing unshield…"
      : opts.protocol === "railgun"
        ? "Building Railgun unshield…"
        : "Building Privacy Pools unshield…"
  );

  const privateOp = await prepareUnshield(asset as AssetAmount, opts.recipient);

  if (mode === "prepare") {
    return {
      privateOp,
      amount: opts.amount,
      recipient: getAddress(opts.recipient) as `0x${string}`,
    };
  }

  opts.onStatus?.("Broadcasting unshield…");
  return await broadcastPreparedPrivateOp(opts.protocol, host, plugin, privateOp);
}

export async function prepareUnshieldOperation(
  opts: UnshieldRuntimeOpts
): Promise<UnshieldPrepared> {
  return (await withProtocolRuntime(
    {
      protocol: opts.protocol,
      rpcUrl: opts.rpcUrl,
      walletDir: opts.walletDir,
      password: opts.password,
      mnemonic: opts.mnemonic,
      chainId: opts.chainId,
    },
    (host, plugin) => runUnshieldWithPlugin(opts, host, plugin, "prepare")
  )) as UnshieldPrepared;
}

export async function broadcastUnshield(opts: UnshieldRuntimeOpts): Promise<unknown> {
  return withProtocolRuntime(
    {
      protocol: opts.protocol,
      rpcUrl: opts.rpcUrl,
      walletDir: opts.walletDir,
      password: opts.password,
      mnemonic: opts.mnemonic,
      chainId: opts.chainId,
    },
    (host, plugin) => runUnshieldWithPlugin(opts, host, plugin, "broadcast")
  );
}

/** Max unshield amount using the shared protocol runtime (safe to call repeatedly for Railgun). */
export async function maxUnshieldAmountHintForWallet(opts: {
  protocol: SupportedProtocol;
  rpcUrl: string;
  walletDir: string;
  password: string;
  mnemonic: string;
  chainId: bigint;
  tokenMeta: ResolvedTokenMeta;
}): Promise<{ cap: bigint; privacyPoolsLargestNote: boolean }> {
  return withProtocolRuntime(
    {
      protocol: opts.protocol,
      rpcUrl: opts.rpcUrl,
      walletDir: opts.walletDir,
      password: opts.password,
      mnemonic: opts.mnemonic,
      chainId: opts.chainId,
    },
    async (_host, plugin) =>
      maxUnshieldAmountHint(opts.protocol, plugin, opts.tokenMeta, opts.chainId)
  );
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
