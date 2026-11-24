import { formatUnits } from "viem";
import { tornadoNoteSelection } from "./tornado-note-selection.js";
type AssetLabel = { decimals: number; symbol: string };

export type TornadoAmountAlternative = { amount: bigint; noteCount: number; scheme: "signature" | "legacy" };

export function tornadoNearestAmounts(schemes: { signature: readonly bigint[]; legacy: readonly bigint[] }, target: bigint, singleNoteOnly = false): {
  lower?: TornadoAmountAlternative; upper?: TornadoAmountAlternative;
} {
  let lower: TornadoAmountAlternative | undefined;
  let upper: TornadoAmountAlternative | undefined;
  // Legacy first matches spending preference when both schemes offer the same sum.
  for (const scheme of ["legacy", "signature"] as const) {
    const notes = schemes[scheme].filter((amount) => amount > 0n);
    if (singleNoteOnly) {
      for (const amount of notes) {
        if (amount < target && (!lower || amount > lower.amount)) lower = { amount, noteCount: 1, scheme };
        if (amount > target && (!upper || amount < upper.amount)) upper = { amount, noteCount: 1, scheme };
      }
      continue;
    }
    const total = notes.reduce((sum, amount) => sum + amount, 0n);
    if (target > 0n) {
      const below = tornadoNoteSelection(notes, target - 1n);
      if (below.amount > 0n && (!lower || below.amount > lower.amount)) {
        lower = { amount: below.amount, noteCount: below.noteCount, scheme };
      }
    }
    if (total > target) {
      const amount = total - tornadoNoteSelection(notes, total - target - 1n).amount;
      const above = tornadoNoteSelection(notes, amount);
      if (!upper || above.amount < upper.amount) upper = { amount: above.amount, noteCount: above.noteCount, scheme };
    }
  }
  return { lower, upper };
}

export function tornadoAlternativeLabel(alternative: TornadoAmountAlternative, asset: AssetLabel): string {
  return `${formatUnits(alternative.amount, asset.decimals)} ${asset.symbol} (${alternative.noteCount} note${alternative.noteCount === 1 ? "" : "s"}, ${alternative.scheme})`;
}

/** Small compatibility summary; suggestions are no longer restricted by shield batch size. */
export function tornadoAvailableAmounts(noteAmounts: readonly bigint[], target: bigint, asset: AssetLabel): string {
  const near = tornadoNearestAmounts({ signature: noteAmounts, legacy: [] }, target);
  const total = noteAmounts.filter((amount) => amount > 0n).reduce((sum, amount) => sum + amount, 0n);
  const values = [near.lower, near.upper, total > 0n ? { amount: total, noteCount: noteAmounts.filter((amount) => amount > 0n).length, scheme: "signature" as const } : undefined]
    .filter((value): value is TornadoAmountAlternative => value != null);
  return [...new Map(values.map((value) => [value.amount, `${formatUnits(value.amount, asset.decimals)} ${asset.symbol} (${value.noteCount} note${value.noteCount === 1 ? "" : "s"})`])).values()].join(", ") || "no spendable notes";
}

export function tornadoUnavailableAmountMessage(
  schemes: { signature: readonly bigint[]; legacy: readonly bigint[] }, amount: bigint, asset: AssetLabel, singleNoteOnly = false
): string {
  const { lower, upper } = tornadoNearestAmounts(schemes, amount, singleNoteOnly);
  const alternatives = [lower ? `nearest below: ${tornadoAlternativeLabel(lower, asset)}` : "no lower amount", upper ? `nearest above: ${tornadoAlternativeLabel(upper, asset)}` : "no higher amount"];
  return `Cannot compose ${formatUnits(amount, asset.decimals)} ${asset.symbol} from whole Tornado notes in a single derivation scheme. ` +
    `Available alternatives before paymaster fees — ${alternatives.join("; ")}. ` +
    "Notes from different schemes cannot be combined; --exclude-new-pools also restricts which notes can be spent. " +
    (singleNoteOnly ? "Multiple-note withdrawals require --next or a stored wallet recipient. " : "") +
    "Amount alternatives do not guarantee bundler acceptance.";
}
