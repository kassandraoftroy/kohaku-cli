/**
 * Tornado paymaster 7702 landing-account policy.
 *
 * The SDK consolidates onto a batch EIP-7702 delegator whenever there are
 * `--tail-calls` or more than one note. Pathless `{ mode: "deterministic" }`
 * makes that delegator a note-derived ephemeral key — not a wallet account —
 * so this CLI never emits it. Wallet-path deterministic is used only for
 * `--next` / stored public HD `--to`. A custom `--to` is allowed only for a
 * single-note unshield with no user tails (proof recipient = `--to`).
 */

export const TORNADO_TAILS_REQUIRE_STORED_HD =
  "Tornado --tail-calls require --next or --to a stored public account. This --to address is not in wallet storage, so the CLI cannot EIP-7702-sign it. Use `unshield --next` (after `next-fresh-address --peek` if you need the address first), or persist the address with `next-fresh-address` then pass it as --to. Peeked addresses are not stored.";

export const TORNADO_MULTI_NOTE_REQUIRE_STORED_HD =
  "This Tornado amount spends multiple notes, which would consolidate onto an EIP-7702 account this wallet does not control. Use --next or --to a stored public account so funds land on a wallet key. A custom --to is only allowed for a single-note unshield with no --tail-calls.";

export type TornadoWalletPathDelegation = {
  mode: "deterministic";
  path: string;
};

function hasWalletHdPath(delegationPath: string | undefined): boolean {
  return Boolean(delegationPath?.trim());
}

/** Fail before gas estimate when user tails would 7702 a mystery address. */
export function assertTornadoTailCallsHaveHdDelegator(
  delegationPath: string | undefined,
  tailCallsCount: number
): void {
  if (tailCallsCount > 0 && !hasWalletHdPath(delegationPath)) {
    throw new Error(TORNADO_TAILS_REQUIRE_STORED_HD);
  }
}

/**
 * Delegation passed to the Tornado SDK.
 * - Stored HD / `--next`: `{ mode: "deterministic", path }` (batch 7702 = that account).
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
      throw new Error(TORNADO_MULTI_NOTE_REQUIRE_STORED_HD);
    }
    return undefined;
  }

  return { mode: "deterministic", path };
}

/** Extra confirm lines so `To:` is never the only story when a 7702 executor exists. */
export function tornadoUnshieldConfirmExtraLines(opts: {
  recipient: `0x${string}`;
  hasHdPath: boolean;
  hasTailCalls: boolean;
  withdrawalCount: number;
}): string[] {
  const consolidates = opts.hasTailCalls || opts.withdrawalCount > 1;
  if (opts.hasHdPath && consolidates) {
    const lines = [`  EIP-7702 executor: ${opts.recipient} (this wallet)`];
    if (opts.hasTailCalls) {
      lines.push("  Tail-calls execute on the EIP-7702 executor");
    }
    return lines;
  }
  if (!opts.hasHdPath) {
    return [
      "  Direct Tornado withdrawal to this address (single note; no wallet 7702 landing account)",
    ];
  }
  return [];
}
