/**
 * Privacy Pools paymaster 7702 landing-account policy.
 *
 * The SDK's default deterministic signer is a note-derived key this wallet does
 * not store. Tail calls and extra notes pay that key and run as it, so leftover
 * funds would sit there unless every custom tail transferred them out. This CLI
 * passes `{ mode: "deterministic", path }` instead, the same way Tornado does.
 * `--next`, a stored public HD `--to`, or a stored stealth `--to` is that path.
 * Stealth indexes use the keystore sentinel, not a second override. A custom
 * `--to` is allowed only for a single-note unshield with no `--tail-calls`
 * (the pool pays that address during validation).
 */

import { isAddressEqual, type Address } from "viem";

import { parseStealthDelegatorPath } from "../lib/stealth/constants.js";
import { formatStealthSelector } from "../lib/stealth/storage.js";

export const PRIVACY_POOLS_TAILS_REQUIRE_WALLET_CONTROLLED =
  "Privacy Pools --tail-calls require --next, --to a stored public account, or --to a stored stealth account (sN). This --to address is not in wallet storage, so the CLI cannot EIP-7702-sign it. Use `unshield --next` (after `next-fresh-address --peek` if you need the address first), persist the address with `next-fresh-address` then pass it as --to, or pass a stored stealth selector. Peeked addresses are not stored.";

export const PRIVACY_POOLS_MULTI_NOTE_REQUIRE_WALLET_CONTROLLED =
  "This Privacy Pools amount spends multiple notes, which would consolidate onto an EIP-7702 account this wallet does not control. Use --next, --to a stored public account, or --to a stored stealth account (sN) so funds land on a wallet key. A custom --to is only allowed for a single-note unshield with no --tail-calls.";

function walletPath(delegationPath: string | undefined): string | undefined {
  const path = delegationPath?.trim();
  return path ? path : undefined;
}

/** Fail before sync when user tails would 7702 an address this wallet cannot sign. */
export function assertPrivacyPoolsTailCallsHaveHdDelegator(
  delegationPath: string | undefined,
  tailCallsCount: number
): void {
  if (tailCallsCount > 0 && !walletPath(delegationPath)) {
    throw new Error(PRIVACY_POOLS_TAILS_REQUIRE_WALLET_CONTROLLED);
  }
}

/**
 * Tail calls and multi-note withdrawals need a stored wallet path.
 * Single-note with no tails does not (proof recipient = `--to`).
 */
export function assertPrivacyPoolsWalletDelegator(opts: {
  delegationPath: string | undefined;
  tailCallsCount: number;
  withdrawalCount: number;
}): void {
  if (!Number.isSafeInteger(opts.withdrawalCount) || opts.withdrawalCount <= 0) {
    throw new Error("Privacy Pools unshield requires at least one withdrawal.");
  }
  assertPrivacyPoolsTailCallsHaveHdDelegator(
    opts.delegationPath,
    opts.tailCallsCount
  );
  if (!walletPath(opts.delegationPath) && opts.withdrawalCount > 1) {
    throw new Error(PRIVACY_POOLS_MULTI_NOTE_REQUIRE_WALLET_CONTROLLED);
  }
}

export type PrivacyPoolsWalletPathDelegation = {
  mode: "deterministic";
  path: string;
};

/**
 * Delegation passed to the Privacy Pools SDK.
 * - Stored HD / `--next` / stored stealth: `{ mode: "deterministic", path }`.
 * - Custom `--to`, single note, no tails: omit `delegation` (prove directly to `--to`).
 */
export function privacyPoolsDelegationConfig(opts: {
  delegationPath: string | undefined;
  tailCallsCount: number;
  withdrawalCount: number;
}): PrivacyPoolsWalletPathDelegation | undefined {
  assertPrivacyPoolsWalletDelegator(opts);
  const path = walletPath(opts.delegationPath);
  if (!path) return undefined;
  return { mode: "deterministic", path };
}

/** Extra confirm lines so `To:` is never the only story when a 7702 executor exists. */
export function privacyPoolsUnshieldConfirmExtraLines(opts: {
  recipient: Address;
  delegationPath?: string;
  hasTailCalls: boolean;
  /** UserOp sender. Equals `recipient` when the wallet path was used. */
  sender?: Address;
}): string[] {
  const path = walletPath(opts.delegationPath);
  const senderIsRecipient =
    opts.sender != null && isAddressEqual(opts.sender, opts.recipient);
  if (path && senderIsRecipient) {
    const stealthIndex = parseStealthDelegatorPath(path);
    const who =
      stealthIndex !== null
        ? `this wallet, stealth ${formatStealthSelector(stealthIndex)}`
        : "this wallet";
    const lines = [`  EIP-7702 executor: ${opts.recipient} (${who})`];
    if (opts.hasTailCalls) {
      lines.push(
        "  Tail-calls execute on the EIP-7702 executor; leftover funds stay on that account"
      );
    } else {
      lines.push("  Withdrawn funds land on the EIP-7702 executor");
    }
    return lines;
  }
  if (!path) {
    return [
      "  Direct Privacy Pools withdrawal to this address (single note; no wallet 7702 landing account)",
    ];
  }
  return [];
}
