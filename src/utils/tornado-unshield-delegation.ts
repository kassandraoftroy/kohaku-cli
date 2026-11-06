/**
 * Tornado paymaster 7702 landing-account policy.
 *
 * The SDK uses an EIP-7702 sender for every unshield. Omitting delegation
 * selects a recoverable note-derived key. Wallet-controlled deterministic is used for
 * `--next` / stored public HD `--to` / stored stealth (`STEALTH_ADDRESS_MAGIC_VALUE_PATH`).
 * For a custom `--to`, the command reserves a fresh public HD executor and
 * passes its path separately from the payout address. User tails still require
 * a wallet-controlled recipient.
 */

import { getAddress } from "viem";
import { publicAccountDerivationPath, selectNextUnusedPublicAccount, type PublicAccountsStorage } from "./public-accounts.js";
import { parseStealthDelegatorPath } from "../lib/stealth/constants.js";
import { formatStealthSelector } from "../lib/stealth/storage.js";

export const TORNADO_TAILS_REQUIRE_WALLET_CONTROLLED =
  "Tornado --tail-calls require --next, --to a stored public account, or --to a stored stealth account (sN). This --to address is not in wallet storage, so the CLI cannot EIP-7702-sign it. Use `unshield --next` (after `next-fresh-address --peek` if you need the address first), persist the address with `next-fresh-address` then pass it as --to, or pass a stored stealth selector. Peeked addresses are not stored.";

export const TORNADO_MULTI_NOTE_REQUIRE_WALLET_CONTROLLED =
  "Multiple-note Tornado withdrawals require a wallet-controlled executor path. The CLI reserves a fresh public account for custom --to recipients.";

export type TornadoWalletPathDelegation = {
  mode: "deterministic";
  path: string;
};

export type TornadoExecutorAccount = {
  address: `0x${string}`;
  index: number;
  delegationPath: string;
};

/** Save the --next account BEFORE preparing signatures: a failed/abandoned
 * prepare or ambiguous broadcast must not lose its refund account or reuse it.
 * Return only public metadata; private keys stay in the encrypted account store. */
export async function reserveTornadoUnshieldExecutor(
  storage: Pick<PublicAccountsStorage, "peekNextAccounts" | "addNextAccounts">,
  isUsed: (address: string) => Promise<boolean>,
): Promise<{ executor: TornadoExecutorAccount; skipped: { address: string; index: number }[] }> {
  const { account, skipped } = await selectNextUnusedPublicAccount(storage, isUsed);
  const [saved] = storage.addNextAccounts(1);
  if (!saved || saved.index !== account.index || saved.address.toLowerCase() !== account.address.toLowerCase()) {
    throw new Error("The selected Tornado executor account changed before reservation. Retry the unshield.");
  }
  return {
    executor: { address: getAddress(account.address), index: account.index, delegationPath: publicAccountDerivationPath(account.index) },
    skipped: skipped.map(({ address, index }) => ({ address, index })),
  };
}

function hasWalletControlledPath(delegationPath: string | undefined): boolean {
  return Boolean(delegationPath?.trim());
}

/** Fail before gas estimate when user tails would 7702 a mystery address. */
export function assertTornadoTailCallsHaveHdDelegator(
  delegationPath: string | undefined,
  tailCallsCount: number
): void {
  if (tailCallsCount > 0 && !hasWalletControlledPath(delegationPath)) {
    throw new Error(TORNADO_TAILS_REQUIRE_WALLET_CONTROLLED);
  }
}

/**
 * Delegation passed to the Tornado SDK.
 * - Stored HD / `--next` / stored stealth / reserved custom-target executor:
 *   `{ mode: "deterministic", path }`.
 * - Custom `--to`, single note, no tails: omit `delegation` (note-derived sender forwards to `--to`).
 */
export function tornadoDelegationConfig(opts: {
  delegationPath: string | undefined;
  tailCallsCount: number;
  withdrawalCount: number;
}): TornadoWalletPathDelegation | undefined {
  if (!Number.isSafeInteger(opts.withdrawalCount) || opts.withdrawalCount <= 0) {
    throw new Error("Tornado unshield requires at least one withdrawal.");
  }

  assertTornadoTailCallsHaveHdDelegator(
    opts.delegationPath,
    opts.tailCallsCount
  );

  const path = opts.delegationPath?.trim();
  if (!path) {
    if (opts.withdrawalCount > 1) {
      throw new Error(TORNADO_MULTI_NOTE_REQUIRE_WALLET_CONTROLLED);
    }
    return undefined;
  }

  return { mode: "deterministic", path };
}

/** Extra confirm lines so `To:` is never the only story when a 7702 executor exists. */
export function tornadoUnshieldConfirmExtraLines(opts: {
  recipient: `0x${string}`;
  delegationPath?: string;
  hasTailCalls: boolean;
  withdrawalCount: number;
  sender?: `0x${string}`;
  executorAccountIndex?: number;
  refundRecipient?: `0x${string}`;
}): string[] {
  const path = opts.delegationPath?.trim() || undefined;
  const hasPath = path != null;
  if (hasPath) {
    const stealthIndex = parseStealthDelegatorPath(path);
    const who =
      stealthIndex !== null
        ? `this wallet, stealth ${formatStealthSelector(stealthIndex)}`
        : opts.executorAccountIndex != null ? `this wallet, public account [${opts.executorAccountIndex}]` : "this wallet";
    const lines = [`  EIP-7702 executor: ${opts.sender ?? opts.recipient} (${who})`];
    if (opts.hasTailCalls) {
      lines.push("  Tail-calls execute on the EIP-7702 executor");
    }
    const sender = opts.sender ?? opts.recipient;
    const refundRecipient = opts.refundRecipient ?? sender;
    if (!opts.hasTailCalls && sender.toLowerCase() !== opts.recipient.toLowerCase()) {
      lines.push(refundRecipient.toLowerCase() === opts.recipient.toLowerCase()
        ? "  The withdrawal pays the recipient directly"
        : "  The executor forwards the withdrawal minus its fee to the recipient");
    }
    lines.push(refundRecipient.toLowerCase() === sender.toLowerCase()
      ? "  Unused-gas refunds stay on this executor"
      : `  Unused-gas refunds go to ${refundRecipient}`);
    return lines;
  }
  if (!hasPath) {
    return [
      `  EIP-7702 executor: ${opts.sender ?? "note-derived sender"} (recoverable from this note's secrets)`,
      "  The executor forwards the withdrawal minus its fee to the recipient; unused-gas refunds stay on the executor",
    ];
  }
  return [];
}
