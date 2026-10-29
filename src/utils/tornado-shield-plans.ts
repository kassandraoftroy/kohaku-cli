import { formatUnits, parseUnits } from "viem";
import type { TornadoSagaPool } from "./tornado-pools.js";

/** Operational margin for the public bundler, not a protocol or gas guarantee. */
export const TORNADO_SHIELD_NOTES_PER_USEROP = 5;
export type TornadoShieldPlan = {
  amount: bigint;
  entries: { pool: TornadoSagaPool; count: number }[];
  noteCount: number;
  batchCount: number;
};

export function excludedTornadoDenominations(values: readonly string[], decimals: number, pools: readonly TornadoSagaPool[]): bigint[] {
  return [...new Set(values.map((value) => {
    if (!/^\d+(\.\d+)?$/.test(value) || (value.split(".")[1]?.length ?? 0) > decimals) {
      throw new Error(`Invalid --exclude-denomination ${value}: use an exact positive amount in token units.`);
    }
    const amount = parseUnits(value, decimals);
    if (amount <= 0n || !pools.some((pool) => pool.denomination === amount)) {
      throw new Error(`--exclude-denomination ${value} is not a supported denomination for this token and chain.`);
    }
    return amount;
  }))];
}

/** Exact branch-and-bound coin selection; never present a greedy approximation as optimal. */
function bestPacking(amount: bigint, pools: readonly TornadoSagaPool[]): TornadoShieldPlan | undefined {
  const sorted = [...pools].sort((a, b) => a.denomination > b.denomination ? -1 : a.denomination < b.denomination ? 1 : 0);
  if (!sorted.length) return undefined;
  if (sorted.length > 16) throw new Error("Too many Tornado denominations to plan safely.");
  if (amount / sorted[0]!.denomination > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;
  const gcd = (a: bigint, b: bigint): bigint => { while (b) [a, b] = [b, a % b]; return a; };
  const suffix = new Array<bigint>(sorted.length);
  for (let i = sorted.length - 1; i >= 0; i--) suffix[i] = gcd(sorted[i]!.denomination, suffix[i + 1] ?? 0n);
  let best: { pool: TornadoSagaPool; count: number }[] | undefined;
  let bestCount = BigInt(Number.MAX_SAFE_INTEGER) + 1n;
  let visited = 0;
  const entries: TornadoShieldPlan["entries"] = [];
  const search = (index: number, remaining: bigint, used: bigint): void => {
    if (++visited > 100_000) throw new Error("Exact Tornado packing search is too large; narrow the allowed denominations.");
    if (!remaining) { best = entries.map((entry) => ({ ...entry })); bestCount = used; return; }
    if (index >= sorted.length || remaining % suffix[index]!) return;
    const pool = sorted[index]!;
    if (used + (remaining + pool.denomination - 1n) / pool.denomination >= bestCount) return;
    if (index === sorted.length - 1) {
      if (remaining % pool.denomination) return;
      const count = remaining / pool.denomination;
      if (used + count >= bestCount) return;
      entries.push({ pool, count: Number(count) });
      best = entries.map((entry) => ({ ...entry })); bestCount = used + count;
      entries.pop(); return;
    }
    for (let count = remaining / pool.denomination; count >= 0n; count--) {
      if (++visited > 100_000) throw new Error("Exact Tornado packing search is too large; narrow the allowed denominations.");
      const rest = remaining - count * pool.denomination;
      const next = sorted[index + 1]!.denomination;
      // Decreasing this count cannot improve the lower bound on note count.
      if (used + count + (rest + next - 1n) / next >= bestCount) break;
      if (rest % suffix[index + 1]!) continue;
      if (count) entries.push({ pool, count: Number(count) });
      search(index + 1, rest, used + count);
      if (count) entries.pop();
    }
  };
  search(0, amount, 0n);
  if (!best || bestCount > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;
  const noteCount = Number(bestCount);
  return { amount, entries: best, noteCount, batchCount: Math.ceil(noteCount / TORNADO_SHIELD_NOTES_PER_USEROP) };
}

/** Optimal packing, classic-only alternative, and alternatives avoiding individual pools. */
export function tornadoShieldPlans(amount: bigint, pools: readonly TornadoSagaPool[], disallowMultiple = false): TornadoShieldPlan[] {
  if (amount <= 0n) throw new Error("Amount must be greater than zero.");
  const plans = new Map<string, TornadoShieldPlan>();
  for (const candidates of [pools, pools.filter((pool) => !pool.isNew), ...pools.map((excluded) => pools.filter((pool) => pool !== excluded))]) {
    const plan = bestPacking(amount, candidates);
    if (!plan || (disallowMultiple && plan.noteCount > TORNADO_SHIELD_NOTES_PER_USEROP)) continue;
    const key = plan.entries.map(({ pool, count }) => `${pool.poolAddress}:${count}`).join(",");
    plans.set(key, plan);
  }
  return [...plans.values()].sort((a, b) => a.noteCount - b.noteCount ||
    a.entries.filter((e) => e.pool.isNew).length - b.entries.filter((e) => e.pool.isNew).length);
}

/** Few useful choices, including a classic-only choice even when it uses more notes. */
export function tornadoShieldChoices(plans: readonly TornadoShieldPlan[]): TornadoShieldPlan[] {
  if (!plans.length) return [];
  const best = plans[0]!;
  const classic = plans.find((plan) => plan.entries.every(({ pool }) => !pool.isNew));
  return [...new Set([best, ...(classic ? [classic] : []), ...plans.slice(1, 3)])].slice(0, 4);
}

export function tornadoShieldPlanLabel(plan: TornadoShieldPlan, decimals: number, symbol: string): string {
  const parts = plan.entries.map(({ pool, count }) => `${count > 1 ? `${count}×` : ""}${formatUnits(pool.denomination, decimals)}${pool.isNew ? "*" : ""}`);
  return `${parts.join(" + ")} ${symbol} · ${plan.noteCount} ${plan.noteCount === 1 ? "note" : "notes"} · ${plan.batchCount} ${plan.batchCount === 1 ? "tx" : "txs"}`;
}

export function requireTornadoShieldPlan(amount: bigint, pools: readonly TornadoSagaPool[], disallowMultiple = false): TornadoShieldPlan {
  if (amount <= 0n) throw new Error("Amount must be greater than zero.");
  const plan = bestPacking(amount, pools);
  if (!plan || (disallowMultiple && plan.batchCount > 1)) throw new Error(disallowMultiple
    ? "No exact Tornado packing fits within five deposit notes with these pool exclusions. Remove --disallow-multiple-userops or choose another amount."
    : "No exact Tornado packing is possible with these pool exclusions. Choose another amount or allow additional denominations.");
  return plan;
}
