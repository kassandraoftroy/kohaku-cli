import { recordSubmission } from "../utils/activity-log.js";
import type { AssetAmount, Host } from "@kohaku-eth/plugins";
import { formatUnits, parseUnits } from "viem";

import { fetchPimlicoMaxFeePerGas } from "../utils/pimlico-gas.js";
import {
  privacyPoolsApprovedNotes,
  privacyPoolsAssetAddress,
  privacyPoolsFeeWei,
  privacyPoolsRequiredGas,
  quotePrivacyPoolsPaymasterFeeInToken,
  sumPrivacyPoolsNoteBalances,
  countPrivacyPoolsNotesForAmount,
  type PpNoteBalance,
} from "../utils/privacy-pools-paymaster.js";
import { railgunPimlicoBundlerUrl } from "../utils/rpc.js";
import { withTor } from "../utils/tor.js";
import type { ResolvedTokenMeta } from "../utils/tokens-util.js";
import {
  isPendingPrivateBalanceRow,
  privateBalanceRowMatchesUnshieldToken,
} from "../utils/tokens-util.js";
import {
  broadcastTornadoPrivateOp,
  privateUnshieldAsset,
  totalTornadoUnspentBalance,
  type AnyPlugin,
  type SupportedProtocol,
} from "../utils/plugins.js";
import { largerSchemeCap } from "../utils/derivation-scheme.js";
import { createTorAwarePaymasterBroadcaster } from "../utils/tornado-paymaster-broadcaster.js";
import {
  computeRailgunMaxUnshieldAmount,
  railgunMaxReceivableFromBalance,
  railgunUnshieldFeeBps,
} from "../utils/railgun-unshield-max.js";
import { withProtocolRuntime } from "./protocol-runtime.js";

export type MaxUnshieldAmountHint = {
  cap: bigint;
  /** Estimated bundler fee reserved from the unshielded ETH balance. */
  estimatedGasFeeWei?: bigint;
  /** Bundler gas price fetch failed, so --amount-max is not reliable. */
  railgunGasEstimateFailed?: boolean;
  /** Railgun: raw spendable balance before fee reserves (for --amount-max refine). */
  railgunBalance?: bigint;
};

async function privacyPoolsMaxReceivable(opts: {
  plugin: unknown;
  tokenMeta: ResolvedTokenMeta;
  chainId: bigint;
  rpcUrl?: string;
}): Promise<MaxUnshieldAmountHint> {
  const target = privacyPoolsAssetAddress(
    opts.tokenMeta.isEth,
    opts.tokenMeta.tokenAddress
  );
  let notes: PpNoteBalance[] = [];
  try {
    const raw = await (
      opts.plugin as {
        notes: (assets?: unknown[], includeSpent?: boolean) => Promise<PpNoteBalance[]>;
      }
    ).notes(undefined, false);
    notes = raw.map((note) => ({
      balance: BigInt(note.balance),
      approved: note.approved,
      assetAddress: note.assetAddress,
    }));
  } catch {
    return { cap: 0n };
  }
  const approved = privacyPoolsApprovedNotes(notes, target);
  const total = sumPrivacyPoolsNoteBalances(approved);
  if (total <= 0n) return { cap: 0n };

  let maxFeePerGas: bigint;
  try {
    maxFeePerGas = await fetchPimlicoMaxFeePerGas(
      railgunPimlicoBundlerUrl(opts.chainId)
    );
  } catch {
    return { cap: 0n, railgunGasEstimateFailed: true };
  }

  let noteCount = 1;
  try {
    noteCount = countPrivacyPoolsNotesForAmount(approved, total);
  } catch {
    return { cap: 0n };
  }
  const feeWei = privacyPoolsFeeWei(
    privacyPoolsRequiredGas({
      isErc20: !opts.tokenMeta.isEth,
      extraWithdrawals: Math.max(0, noteCount - 1),
      hasUserTailCalls: false,
    }),
    maxFeePerGas
  );
  let fee = feeWei;
  if (!opts.tokenMeta.isEth) {
    if (!opts.rpcUrl) return { cap: 0n, railgunGasEstimateFailed: true };
    try {
      fee = await quotePrivacyPoolsPaymasterFeeInToken({
        rpcUrl: opts.rpcUrl,
        chainId: opts.chainId,
        feeToken: opts.tokenMeta.tokenAddress as `0x${string}`,
        feeWei,
      });
    } catch {
      return { cap: 0n, railgunGasEstimateFailed: true };
    }
  }
  return {
    cap: fee >= total ? 0n : total - fee,
    estimatedGasFeeWei: opts.tokenMeta.isEth ? feeWei : undefined,
  };
}

export async function maxUnshieldAmountHint(
  protocol: SupportedProtocol,
  plugin: unknown,
  tokenMeta: ResolvedTokenMeta,
  chainId: bigint,
  rpcUrl?: string
): Promise<MaxUnshieldAmountHint> {
  if (protocol === "privacy-pools") {
    return privacyPoolsMaxReceivable({ plugin, tokenMeta, chainId, rpcUrl });
  }

  if (protocol !== "railgun" && protocol !== "tornado") {
    return { cap: 0n };
  }

  // Tornado: max is the sum of this scheme's unspent notes for the token.
  if (protocol === "tornado") {
    try {
      const asset = privateUnshieldAsset(protocol, chainId, tokenMeta, 1n);
      const cap = await totalTornadoUnspentBalance(plugin as AnyPlugin, asset.asset);
      return { cap };
    } catch {
      return { cap: 0n };
    }
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

  if (sum > 0n) {
    try {
      const { amount, estimatedGasFeeWei } = await computeRailgunMaxUnshieldAmount({
        chainId,
        balance: sum,
        tokenMeta,
      });
      return {
        cap: amount,
        estimatedGasFeeWei,
        railgunBalance: sum,
      };
    } catch {
      // Soft fallback for prompts: treasury fee only (no gas reserve).
      const amount = railgunMaxReceivableFromBalance(
        sum,
        railgunUnshieldFeeBps(chainId),
        0n
      );
      return {
        cap: amount,
        railgunGasEstimateFailed: true,
        railgunBalance: sum,
      };
    }
  }

  return { cap: sum, railgunBalance: sum };
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
  const withdrawal = (
    operation as {
      withdrawal?: {
        mode: "paymaster";
        bundlerUrl: string;
        entryPointAddress: `0x${string}`;
        userOperation: unknown;
      };
    }
  ).withdrawal;
  if (!withdrawal?.userOperation) {
    throw new Error("Privacy Pools paymaster withdrawal is missing a signed user operation.");
  }
  const [result] = await createTorAwarePaymasterBroadcaster(chainId).broadcast([
    withdrawal as never,
  ]);
  if (!result) {
    throw new Error("Privacy Pools paymaster withdrawal failed to broadcast.");
  }
  return result;
}

type RailgunBroadcastPlugin = {
  broadcast: (op: unknown) => Promise<void>;
  bundler?: {
    sendUserOperation: (...args: unknown[]) => Promise<unknown>;
    waitForReceipt?: (...args: unknown[]) => Promise<unknown>;
  };
};

/** Railgun `broadcast()` returns void but Pimlico yields a userOpHash from `sendUserOperation`. */
async function broadcastRailgunOp(
  plugin: unknown,
  operation: unknown
): Promise<{ userOpHash: string; txHash?: string } | undefined> {
  const rg = plugin as RailgunBroadcastPlugin;
  let userOpHash: string | undefined;
  let txHash: string | undefined;
  let updateActivity: ReturnType<typeof recordSubmission> | undefined;
  const bundler = rg.bundler;
  let restoreSend: (() => void) | undefined;

  if (bundler && typeof bundler.sendUserOperation === "function") {
    const original = bundler.sendUserOperation.bind(bundler);
    bundler.sendUserOperation = async (...args: unknown[]) => {
      const result = await original(...args);
      if (typeof result === "string" && /^0x[a-fA-F0-9]{64}$/.test(result)) {
        userOpHash = result;
        updateActivity = recordSubmission({ userOpHash });
      }
      return result;
    };
    const originalWait = bundler.waitForReceipt?.bind(bundler);
    if (originalWait) {
      bundler.waitForReceipt = async (...args: unknown[]) => {
        const receipt = await originalWait(...args) as { success?: boolean; receipt?: { transactionHash?: string } };
        txHash = receipt.receipt?.transactionHash;
        updateActivity?.({ txHash, status: receipt.success === false ? "reverted" : "confirmed" });
        if (receipt.success === false) throw new Error(`User operation reverted: ${userOpHash}`);
        return receipt;
      };
    }
    restoreSend = () => {
      bundler.sendUserOperation = original;
      if (originalWait) bundler.waitForReceipt = originalWait;
    };
  }

  try {
    await rg.broadcast(operation);
  } finally {
    restoreSend?.();
  }

  return userOpHash ? { userOpHash, ...(txHash ? { txHash } : {}) } : undefined;
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
 * Hash suitable for an explorer `/tx/` after an ERC-4337 unshield.
 * Prefers the bundler userOpHash, then a mined transaction hash.
 */
export function extractUnshieldExplorerHash(result: unknown): string | null {
  return findHashDeep(result, RAILGUN_EXPLORER_HASH_KEYS);
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
  withoutTor?: boolean;
}): Promise<MaxUnshieldAmountHint> {
  return withTor(!opts.withoutTor, { rpcUrl: opts.rpcUrl, walletDir: opts.walletDir }, () =>
    withProtocolRuntime(
      {
        protocol: opts.protocol,
        rpcUrl: opts.rpcUrl,
        walletDir: opts.walletDir,
        password: opts.password,
        mnemonic: opts.mnemonic,
        chainId: opts.chainId,
      },
      async (_host, plugins) => {
        if (opts.protocol === "railgun") {
          return maxUnshieldAmountHint(
            opts.protocol,
            plugins.signature,
            opts.tokenMeta,
            opts.chainId,
            opts.rpcUrl
          );
        }
        const legacy = await maxUnshieldAmountHint(
          opts.protocol,
          plugins.legacy,
          opts.tokenMeta,
          opts.chainId,
          opts.rpcUrl
        );
        const signature = await maxUnshieldAmountHint(
          opts.protocol,
          plugins.signature,
          opts.tokenMeta,
          opts.chainId,
          opts.rpcUrl
        );
        const cap = largerSchemeCap(legacy.cap, signature.cap);
        const winner = signature.cap > legacy.cap ? signature : legacy;
        return {
          cap,
          estimatedGasFeeWei: winner.estimatedGasFeeWei,
          railgunGasEstimateFailed:
            cap === 0n
              ? legacy.railgunGasEstimateFailed && signature.railgunGasEstimateFailed
              : winner.railgunGasEstimateFailed,
          railgunBalance: winner.railgunBalance,
        };
      }
    )
  );
}

export function parseUnshieldAmount(
  raw: string,
  decimals: number,
  maxAmountHint: bigint
): bigint {
  const trimmed = raw.trim();
  if (trimmed.toLowerCase() === "max") {
    if (maxAmountHint <= 0n) {
      throw new Error("Could not determine max unshield amount.");
    }
    return maxAmountHint;
  }
  const parsed = parseUnits(trimmed, decimals);
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
