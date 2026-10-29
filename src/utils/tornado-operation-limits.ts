import { formatUnits } from "viem";
type AssetLabel = { decimals: number; symbol: string };

export type TornadoAmountAlternative = { amount: bigint; noteCount: number; scheme: "signature" | "legacy" };

/** Greedy selection is monotone in target; its result is the nearest accepted amount below it. */
function greedyAmount(notes: readonly bigint[], target: bigint): { amount: bigint; noteCount: number } {
  const counts = new Map<bigint, bigint>();
  for (const amount of notes) if (amount > 0n) counts.set(amount, (counts.get(amount) ?? 0n) + 1n);
  let remaining = target;
  let noteCount = 0;
  for (const [denomination, available] of [...counts].sort(([a], [b]) => a > b ? -1 : a < b ? 1 : 0)) {
    const used = remaining / denomination < available ? remaining / denomination : available;
    remaining -= used * denomination;
    noteCount += Number(used);
  }
  return { amount: target - remaining, noteCount };
}

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
      const below = greedyAmount(notes, target - 1n);
      if (below.amount > 0n && (!lower || below.amount > lower.amount)) lower = { ...below, scheme };
    }
    if (total > target) {
      let left = target + 1n;
      let right = total;
      while (left < right) {
        const mid = (left + right) / 2n;
        if (greedyAmount(notes, mid).amount > target) right = mid;
        else left = mid + 1n;
      }
      const above = greedyAmount(notes, left);
      if (!upper || above.amount < upper.amount) upper = { ...above, scheme };
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
  const values = [near.lower, near.upper, total > 0n ? { ...greedyAmount(noteAmounts, total), scheme: "signature" as const } : undefined]
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
