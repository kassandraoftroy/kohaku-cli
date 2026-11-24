export type TornadoNoteSelection = {
  amount: bigint;
  noteCount: number;
  counts: Map<bigint, number>;
};

/** Largest whole-note sum at or below target, preferring larger notes like the SDK. */
export function tornadoNoteSelection(noteAmounts: readonly bigint[], target: bigint): TornadoNoteSelection {
  const byAmount = new Map<bigint, number>();
  for (const amount of noteAmounts) {
    if (amount > 0n) byAmount.set(amount, (byAmount.get(amount) ?? 0) + 1);
  }
  const groups = [...byAmount].sort(([a], [b]) => a > b ? -1 : a < b ? 1 : 0);
  const capacity = Array<bigint>(groups.length + 1).fill(0n);
  const divisor = [...capacity];
  for (let index = groups.length - 1; index >= 0; index--) {
    const [amount, count] = groups[index]!;
    capacity[index] = capacity[index + 1]! + amount * BigInt(count);
    let a = amount;
    let b = divisor[index + 1]!;
    while (b !== 0n) [a, b] = [b, a % b];
    divisor[index] = a;
  }
  const empty = (): TornadoNoteSelection => ({ amount: 0n, noteCount: 0, counts: new Map() });
  const memo = groups.map(() => new Map<bigint, TornadoNoteSelection>());
  const search = (index: number, limit: bigint): TornadoNoteSelection => {
    if (limit <= 0n || index === groups.length) return empty();
    const cached = memo[index]!.get(limit);
    if (cached) return cached;
    const [amount, available] = groups[index]!;
    const bounded = limit < capacity[index]! ? limit : capacity[index]!;
    const ceiling = bounded - bounded % divisor[index]!;
    const maxCount = Number(limit / amount < BigInt(available) ? limit / amount : BigInt(available));
    let best = empty();
    for (let count = maxCount; count >= 0; count--) {
      const subtotal = amount * BigInt(count);
      const rest = limit - subtotal;
      const suffixBound = rest < capacity[index + 1]! ? rest : capacity[index + 1]!;
      const suffixDivisor = divisor[index + 1]!;
      const suffixCeiling = suffixDivisor > 0n ? suffixBound - suffixBound % suffixDivisor : 0n;
      if (subtotal + suffixCeiling <= best.amount) continue;
      const suffix = search(index + 1, rest);
      const total = subtotal + suffix.amount;
      if (total > best.amount) {
        best = { amount: total, noteCount: count + suffix.noteCount,
          counts: new Map(count > 0 ? [[amount, count], ...suffix.counts] : suffix.counts) };
      }
      if (best.amount === ceiling) break;
    }
    memo[index]!.set(limit, best);
    return best;
  };
  return search(0, target);
}
