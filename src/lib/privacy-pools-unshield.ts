import { PPv1ExactOutputError } from "@kohaku-eth/privacy-pools";
import type { AssetAmount } from "@kohaku-eth/plugins";

import { fetchPimlicoMaxFeePerGas } from "../utils/pimlico-gas.js";
import {
  assertPrivacyPoolsPaymasterConfigured,
  countPrivacyPoolsNotesForAmount,
  privacyPoolsApprovedNotes,
  privacyPoolsAssetAddress,
  privacyPoolsFeeWei,
  privacyPoolsRequiredGas,
  privacyPoolsTailCallsGasEstimate,
  privacyPoolsUserTailCalls,
  quotePrivacyPoolsPaymasterFeeInToken,
  type PpNoteBalance,
  type UnshieldTailCall,
} from "../utils/privacy-pools-paymaster.js";
import {
  privateUnshieldAsset,
  railgunUnshieldOptions,
  tornadoUnshieldOptions,
  type AnyPlugin,
  type SupportedProtocol,
  type TornadoErc20TailForward,
} from "../utils/plugins.js";
import {
  assertPrivacyPoolsWalletDelegator,
  bindPrivacyPoolsWalletDelegator,
} from "../utils/privacy-pools-unshield-delegation.js";
import { railgunPimlicoBundlerUrl } from "../utils/rpc.js";
import type { ResolvedTokenMeta } from "../utils/tokens-util.js";

type PrepareUnshield = (
  asset: AssetAmount,
  recipient: `0x${string}`,
  options?: unknown
) => Promise<unknown>;

function asNotes(raw: unknown[]): PpNoteBalance[] {
  return raw.map((item) => {
    const note = item as {
      balance?: bigint | number | string;
      approved?: boolean;
      assetAddress?: bigint | string;
    };
    return {
      balance: note.balance == null ? 0n : BigInt(note.balance),
      approved: note.approved,
      assetAddress: note.assetAddress ?? 0n,
    };
  });
}

/** Fee committed in a prepared Privacy Pools paymaster withdrawal. */
export function privacyPoolsPreparedFee(operation: unknown): bigint | null {
  const op = operation as {
    withdrawal?: { fee?: bigint | number | string };
    exact?: { fee?: bigint | number | string };
  };
  const raw = op.withdrawal?.fee ?? op.exact?.fee;
  return raw == null ? null : BigInt(raw);
}

/** UserOp sender after a paymaster prepare, when the SDK included one. */
export function privacyPoolsPreparedSender(
  operation: unknown
): `0x${string}` | undefined {
  const sender = (
    operation as {
      withdrawal?: { userOperation?: { sender?: string } };
    }
  ).withdrawal?.userOperation?.sender;
  return typeof sender === "string" && sender.startsWith("0x")
    ? (sender as `0x${string}`)
    : undefined;
}

/**
 * Prepare a paymaster unshield whose recipient receives `amountWei` (the net).
 * The private balance pays the net plus the paymaster fee. Largest approved
 * note is spent first; further notes run as execution-phase withdrawals on
 * `--to`, which must be a stored wallet account so it can sign the 7702
 * delegation and keep any change.
 */
export async function preparePrivacyPoolsUnshield(opts: {
  plugin: AnyPlugin;
  chainId: bigint;
  rpcUrl: string;
  tokenMeta: ResolvedTokenMeta;
  amountWei: bigint;
  recipient: `0x${string}`;
  tailCalls: readonly UnshieldTailCall[];
  recipientDerivationPath?: string;
  recipientPrivateKey?: `0x${string}`;
}): Promise<unknown> {
  assertPrivacyPoolsPaymasterConfigured(opts.chainId);
  const prepare = opts.plugin.prepareUnshield as PrepareUnshield | undefined;
  if (!prepare) {
    throw new Error("Privacy Pools plugin does not expose prepareUnshield.");
  }
  if (!opts.plugin.notes) {
    throw new Error("Privacy Pools plugin does not expose notes.");
  }

  const asset = privacyPoolsAssetAddress(
    opts.tokenMeta.isEth,
    opts.tokenMeta.tokenAddress
  );
  const notes = privacyPoolsApprovedNotes(
    asNotes(await opts.plugin.notes(undefined, false)),
    asset
  );
  const hasTails = opts.tailCalls.length > 0;
  const tailGas = hasTails
    ? privacyPoolsTailCallsGasEstimate(opts.tailCalls.length)
    : undefined;
  const maxFeePerGas = await fetchPimlicoMaxFeePerGas(
    railgunPimlicoBundlerUrl(opts.chainId)
  );
  const isErc20 = !opts.tokenMeta.isEth;

  const feeFor = async (extraWithdrawals: number): Promise<bigint> => {
    const feeWei = privacyPoolsFeeWei(
      privacyPoolsRequiredGas({
        isErc20,
        extraWithdrawals,
        hasUserTailCalls: hasTails,
        tailCallsGasEstimate: tailGas,
      }),
      maxFeePerGas
    );
    if (!isErc20) return feeWei;
    return quotePrivacyPoolsPaymasterFeeInToken({
      rpcUrl: opts.rpcUrl,
      chainId: opts.chainId,
      feeToken: opts.tokenMeta.tokenAddress as `0x${string}`,
      feeWei,
    });
  };

  let extra = 0;
  let fee = await feeFor(0);
  for (let i = 0; i < 4; i++) {
    const count = countPrivacyPoolsNotesForAmount(notes, opts.amountWei + fee);
    const nextExtra = Math.max(0, count - 1);
    const nextFee = await feeFor(nextExtra);
    if (nextFee === fee && nextExtra === extra) break;
    extra = nextExtra;
    fee = nextFee;
  }

  const assetFor = (amount: bigint) =>
    privateUnshieldAsset("privacy-pools", opts.chainId, opts.tokenMeta, amount);

  assertPrivacyPoolsWalletDelegator({
    delegationPath: opts.recipientDerivationPath,
    tailCallsCount: opts.tailCalls.length,
    withdrawalCount: extra + 1,
  });

  if (!hasTails && extra === 0) {
    try {
      return await prepare(assetFor(opts.amountWei), opts.recipient, {
        mode: "paymaster",
        batch: true,
        refundRecipient: opts.recipient,
        exact: {},
      });
    } catch (err) {
      if (!(err instanceof PPv1ExactOutputError)) throw err;
      fee += err.requestedNet - err.expectedNet;
    }
  }

  const userTailCalls = hasTails
    ? privacyPoolsUserTailCalls({
        net: opts.amountWei,
        isEth: opts.tokenMeta.isEth,
        userTailCalls: opts.tailCalls,
      })
    : undefined;

  const options = {
    mode: "paymaster" as const,
    batch: true as const,
    refundRecipient: opts.recipient,
    ...(userTailCalls
      ? {
          tailCalls: async () => userTailCalls,
          tailCallsGasEstimate: tailGas,
        }
      : {}),
  };

  const needsWalletDelegator = hasTails || extra > 0;
  let restoreDelegator: (() => void) | undefined;
  if (needsWalletDelegator) {
    const privateKey = opts.recipientPrivateKey;
    if (!privateKey) {
      throw new Error("Privacy Pools unshield is missing the wallet key for --to.");
    }
    restoreDelegator = bindPrivacyPoolsWalletDelegator(
      opts.plugin,
      privateKey,
      opts.recipient
    );
  }
  try {
    let reserved = fee;
    let operation: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      operation = await prepare(
        assetFor(opts.amountWei + reserved),
        opts.recipient,
        options
      );
      const built = privacyPoolsPreparedFee(operation);
      if (built == null) {
        throw new Error("Privacy Pools paymaster withdrawal did not include a fee.");
      }
      if (reserved >= built) return operation;
      if (attempt === 0) {
        reserved = built;
        continue;
      }
      throw new Error(
        "Privacy Pools paymaster fee rose above the reserved private balance. Retry the unshield."
      );
    }
    return operation;
  } finally {
    restoreDelegator?.();
  }
}

/** One prepare entry for every protocol. Protocol-specific options stay inside. */
export async function prepareProtocolUnshield(opts: {
  protocol: SupportedProtocol;
  plugin: AnyPlugin;
  chainId: bigint;
  rpcUrl: string;
  tokenMeta: ResolvedTokenMeta;
  amountWei: bigint;
  recipient: `0x${string}`;
  tailCalls: readonly UnshieldTailCall[];
  recipientDerivationPath?: string;
  recipientPrivateKey?: `0x${string}`;
  tornadoMaxFeePerGas?: bigint;
  tornadoWithdrawalCount?: number;
  tornadoTailCallsGasEstimate?: bigint;
  tornadoErc20Tail?: TornadoErc20TailForward;
}): Promise<unknown> {
  if (opts.protocol === "privacy-pools") {
    return preparePrivacyPoolsUnshield(opts);
  }
  const prepare = opts.plugin.prepareUnshield?.bind(opts.plugin);
  if (!prepare) {
    throw new Error(`${opts.protocol} plugin does not expose prepareUnshield.`);
  }
  const asset = privateUnshieldAsset(
    opts.protocol,
    opts.chainId,
    opts.tokenMeta,
    opts.amountWei
  );
  if (opts.protocol === "tornado") {
    return prepare(
      asset,
      opts.recipient,
      tornadoUnshieldOptions(
        opts.recipient,
        opts.amountWei,
        opts.tornadoMaxFeePerGas!,
        opts.recipientDerivationPath,
        opts.tornadoWithdrawalCount!,
        opts.tailCalls,
        opts.tornadoTailCallsGasEstimate,
        opts.tornadoErc20Tail
      )
    );
  }
  return prepare(asset, opts.recipient, railgunUnshieldOptions(opts.tailCalls));
}
