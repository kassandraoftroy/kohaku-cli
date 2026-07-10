import {
  createPPv1Broadcaster,
  PrivacyPoolsV1_0xBow,
} from "@kohaku-eth/privacy-pools";
import type { AssetAmount, Host } from "@kohaku-eth/plugins";
import { Contract, formatUnits, getAddress, parseUnits } from "ethers";

import { makeEthersProvider, railgunPimlicoBundlerUrl } from "../utils/rpc.js";
import type { ResolvedTokenMeta } from "../utils/tokens-util.js";
import {
  isPendingPrivateBalanceRow,
  privateBalanceRowMatchesUnshieldToken,
} from "../utils/tokens-util.js";
import {
  assertTornadoPaymasterConfigured,
  broadcastTornadoPrivateOp,
  configureRailgunForUnshield,
  ETH_AS_ERC20,
  PRIVACY_POOLS_BROADCASTER_URL,
  railgunNativeEthAssetAmount,
  tornadoUnshieldOptions,
  type SupportedProtocol,
} from "../utils/plugins.js";
import { resolveTornadoPrepareMaxFeePerGas } from "../utils/tornado-paymaster-gas.js";
import { withProtocolRuntime } from "./protocol-runtime.js";

type PpNoteForMax = { balance: bigint; assetAddress: bigint | string };

const PP_ENTRYPOINT_ASSET_CONFIG_ABI = [
  "function assetConfig(address _asset) view returns (address pool, uint256 minimumDepositAmount, uint256 vettingFeeBPS, uint256 maxRelayFeeBPS)",
] as const;

type PpPreparedOp = {
  rawData?: {
    relayData?: { relayFeeBps?: bigint | number | string };
  };
};

function relayFeeBpsFromPreparedOp(prepared: unknown): bigint | null {
  const raw = (prepared as PpPreparedOp)?.rawData?.relayData?.relayFeeBps;
  return raw != null ? BigInt(raw) : null;
}

async function fetchPrivacyPoolsMaxRelayFeeBps(
  rpcUrl: string,
  chainId: bigint
): Promise<bigint | null> {
  const deployment = PrivacyPoolsV1_0xBow[Number(chainId) as 1 | 11155111];
  if (!deployment) return null;
  const provider = await makeEthersProvider(rpcUrl);
  try {
    const entrypoint = new Contract(
      deployment.entrypoint.entrypointAddress,
      PP_ENTRYPOINT_ASSET_CONFIG_ABI,
      provider
    );
    const cfg = await entrypoint.assetConfig(ETH_AS_ERC20);
    return BigInt(cfg.maxRelayFeeBPS);
  } catch {
    return null;
  } finally {
    provider.destroy();
  }
}

/** Rejects before broadcast when the relayer quote exceeds the entrypoint relay-fee cap. */
export async function assertPrivacyPoolsRelayFeeWithinCap(
  prepared: unknown,
  rpcUrl: string,
  chainId: bigint
): Promise<void> {
  const relayFeeBps = relayFeeBpsFromPreparedOp(prepared);
  const maxBps = await fetchPrivacyPoolsMaxRelayFeeBps(rpcUrl, chainId);
  if (relayFeeBps == null || maxBps == null) return;
  if (relayFeeBps <= maxBps) return;

  throw new Error(
    `Privacy Pools relayer fee too high: ${PRIVACY_POOLS_BROADCASTER_URL} quoted ${relayFeeBps} bps ` +
      `(${(Number(relayFeeBps) / 100).toFixed(2)}%) but this chain's entrypoint allows at most ` +
      `${maxBps} bps (${(Number(maxBps) / 100).toFixed(2)}%). ` +
      `This is not about note size — try a larger withdrawal amount or ask the relayer operator to lower fees.`
  );
}

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

  if (protocol !== "railgun" && protocol !== "tornado") {
    return { cap: 0n, privacyPoolsLargestNote: false };
  }

  let sum = 0n;
  try {
    const balances: AssetAmount[] = await (
      plugin as unknown as { balance: (a: unknown) => Promise<AssetAmount[]> }
    ).balance(undefined);
    for (const row of balances) {
      if (isPendingPrivateBalanceRow(row)) continue;
      const asset = row.asset as { __type?: string; contract?: unknown } | undefined;
      if (!asset || asset.__type !== "erc20") continue;
      let addr: string;
      if (typeof asset.contract === "string") addr = asset.contract.toLowerCase();
      else if (typeof asset.contract === "bigint")
        addr = `0x${asset.contract.toString(16).padStart(40, "0")}`.toLowerCase();
      else continue;
      if (
        privateBalanceRowMatchesUnshieldToken(addr, tokenMeta, chainId, protocol)
      ) {
        sum += row.amount;
      }
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
  operation: unknown,
  chainId: bigint
): Promise<unknown> {
  if (protocol === "railgun") {
    return await broadcastRailgunOp(plugin, operation);
  }
  if (protocol === "tornado") {
    return await broadcastTornadoPrivateOp(host, operation, chainId);
  }
  const broadcaster = createPPv1Broadcaster(host, {
    broadcasterUrl: PRIVACY_POOLS_BROADCASTER_URL,
  });
  return await broadcaster.broadcast(operation as never);
}

type RailgunBroadcastPlugin = {
  broadcast: (op: unknown) => Promise<void>;
  bundler?: {
    sendUserOperation: (...args: unknown[]) => Promise<unknown>;
  };
};

/** Railgun `broadcast()` returns void but Pimlico yields a userOpHash from `sendUserOperation`. */
async function broadcastRailgunOp(
  plugin: unknown,
  operation: unknown
): Promise<{ userOpHash: string } | undefined> {
  const rg = plugin as RailgunBroadcastPlugin;
  let userOpHash: string | undefined;
  const bundler = rg.bundler;
  let restoreSend: (() => void) | undefined;

  if (bundler && typeof bundler.sendUserOperation === "function") {
    const original = bundler.sendUserOperation.bind(bundler);
    bundler.sendUserOperation = async (...args: unknown[]) => {
      const result = await original(...args);
      if (typeof result === "string" && /^0x[a-fA-F0-9]{64}$/.test(result)) {
        userOpHash = result;
      }
      return result;
    };
    restoreSend = () => {
      bundler.sendUserOperation = original;
    };
  }

  try {
    await rg.broadcast(operation);
  } finally {
    restoreSend?.();
  }

  return userOpHash ? { userOpHash } : undefined;
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
      host,
      opts.chainId,
      opts.recipientPriv,
      railgunPimlicoBundlerUrl(opts.chainId)
    );
  }

  const maybeSync = plugin as { sync?: () => Promise<void> };
  if (
    (opts.protocol === "privacy-pools" || opts.protocol === "tornado") &&
    typeof maybeSync.sync === "function"
  ) {
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
      prepareUnshield: (
        a: AssetAmount,
        t: `0x${string}`,
        options?: { mode: "paymaster" } | { mode: "relayer" }
      ) => Promise<unknown>;
    }
  ).prepareUnshield.bind(plugin);

  if (opts.protocol === "tornado") {
    assertTornadoPaymasterConfigured(opts.chainId);
  }

  let tornadoMaxFeePerGas: bigint | undefined;
  if (opts.protocol === "tornado") {
    tornadoMaxFeePerGas = await resolveTornadoPrepareMaxFeePerGas(opts.chainId);
  }

  opts.onStatus?.(
    mode === "broadcast"
      ? "Preparing unshield…"
      : opts.protocol === "railgun"
        ? "Building Railgun unshield…"
        : opts.protocol === "tornado"
          ? "Building Tornado Cash unshield…"
          : "Building Privacy Pools unshield…"
  );

  const privateOp =
    opts.protocol === "tornado"
      ? await prepareUnshield(
          asset as AssetAmount,
          opts.recipient,
          tornadoUnshieldOptions(
            opts.recipient,
            opts.amount,
            tornadoMaxFeePerGas!
          )
        )
      : await prepareUnshield(asset as AssetAmount, opts.recipient);

  if (opts.protocol === "privacy-pools") {
    await assertPrivacyPoolsRelayFeeWithinCap(
      privateOp,
      opts.rpcUrl,
      opts.chainId
    );
  }

  if (mode === "prepare") {
    return {
      privateOp,
      amount: opts.amount,
      recipient: getAddress(opts.recipient) as `0x${string}`,
    };
  }

  opts.onStatus?.("Broadcasting unshield…");
  return await broadcastPreparedPrivateOp(
    opts.protocol,
    host,
    plugin,
    privateOp,
    opts.chainId
  );
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

const ON_CHAIN_TX_HASH_KEYS = [
  "txHash",
  "bundleTxHash",
  "transactionHash",
] as const;

const RAILGUN_EXPLORER_HASH_KEYS = [
  "userOpHash",
  ...ON_CHAIN_TX_HASH_KEYS,
] as const;

function findHashDeep(
  value: unknown,
  prioritizedKeys: readonly string[]
): string | null {
  if (typeof value === "string") {
    return /^0x[a-fA-F0-9]{64}$/.test(value) ? value : null;
  }
  if (typeof value !== "object" || value === null) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = findHashDeep(item, prioritizedKeys);
      if (hit) return hit;
    }
    return null;
  }

  const obj = value as Record<string, unknown>;
  for (const k of prioritizedKeys) {
    const hit = findHashDeep(obj[k], prioritizedKeys);
    if (hit) return hit;
  }

  for (const v of Object.values(obj)) {
    const hit = findHashDeep(v, prioritizedKeys);
    if (hit) return hit;
  }
  return null;
}

/**
 * Hash suitable for Etherscan `/tx/` after unshield broadcast.
 * - Railgun / Tornado paymaster (4337): userOpHash from Pimlico, or a mined tx hash.
 * - Privacy Pools: on-chain tx hash only (`txHash` from relayer) — no userOpHash.
 */
export function extractUnshieldExplorerHash(
  result: unknown,
  protocol: SupportedProtocol
): string | null {
  const keys =
    protocol === "railgun" || protocol === "tornado"
      ? RAILGUN_EXPLORER_HASH_KEYS
      : ON_CHAIN_TX_HASH_KEYS;
  return findHashDeep(result, keys);
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
