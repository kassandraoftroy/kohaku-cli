/**
 * Tornado paymaster 7702 landing-account policy.
 *
 * The SDK consolidates onto a batch EIP-7702 delegator whenever there are
 * `--tail-calls` or more than one note. Pathless `{ mode: "deterministic" }`
 * makes that delegator a note-derived ephemeral key — not a wallet account —
 * so this CLI never emits it. Wallet-controlled deterministic is used for
 * `--next` / stored public HD `--to` / stored stealth (`STEALTH_ADDRESS_MAGIC_VALUE_PATH`).
 * A custom `--to` is allowed only for a single-note unshield with no user tails
 * (proof recipient = `--to`).
 */

import { parseStealthDelegatorPath } from "../lib/stealth/constants.js";
import { formatStealthSelector } from "../lib/stealth/storage.js";

export const TORNADO_TAILS_REQUIRE_WALLET_CONTROLLED =
  "Tornado --tail-calls require --next, --to a stored public account, or --to a stored stealth account (sN). This --to address is not in wallet storage, so the CLI cannot EIP-7702-sign it. Use `unshield --next` (after `next-fresh-address --peek` if you need the address first), persist the address with `next-fresh-address` then pass it as --to, or pass a stored stealth selector. Peeked addresses are not stored.";

export const TORNADO_MULTI_NOTE_REQUIRE_WALLET_CONTROLLED =
  "This Tornado amount spends multiple notes, which would consolidate onto an EIP-7702 account this wallet does not control. Use --next, --to a stored public account, or --to a stored stealth account (sN) so funds land on a wallet key. A custom --to is only allowed for a single-note unshield with no --tail-calls.";

export type TornadoWalletPathDelegation = {
  mode: "deterministic";
  path: string;
};

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
 * - Stored HD / `--next` / stored stealth: `{ mode: "deterministic", path }`.
 * - Custom `--to`, single note, no tails: omit `delegation` (prove directly to `--to`).
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
}): string[] {
  const path = opts.delegationPath?.trim() || undefined;
  const hasPath = path != null;
  const consolidates = opts.hasTailCalls || opts.withdrawalCount > 1;
  if (hasPath && consolidates) {
    const stealthIndex = parseStealthDelegatorPath(path);
    const who =
      stealthIndex !== null
        ? `this wallet, stealth ${formatStealthSelector(stealthIndex)}`
        : "this wallet";
    const lines = [`  EIP-7702 executor: ${opts.recipient} (${who})`];
    if (opts.hasTailCalls) {
      lines.push("  Tail-calls execute on the EIP-7702 executor");
    }
    return lines;
  }
  if (!hasPath) {
    return [
      "  Direct Tornado withdrawal to this address (single note; no wallet 7702 landing account)",
    ];
  }
  return [];
}
