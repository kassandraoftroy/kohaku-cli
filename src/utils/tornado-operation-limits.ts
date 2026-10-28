import { formatUnits } from "viem";
import { tornadoPoolsForAsset } from "./tornado-pools.js";
import { selectTornadoWithdrawalNotes } from "./tornado-unshield-pools.js";

/** CLI policy for public-bundler shields, not a Tornado protocol limit. */
export const TORNADO_MAX_SHIELD_NOTES = 5;

type AssetLabel = { decimals: number; symbol: string };

/** Check the SDK's largest-first packing before preparing/reserving commitments. */
export function assertTornadoShieldNoteLimit(
  chainId: bigint,
  amount: bigint,
  asset: AssetLabel & { isEth: boolean; tokenAddress: string; excludeNewPools?: boolean }
): void {
  const denominations = [...new Set(tornadoPoolsForAsset(chainId, asset).map((p) => p.denomination))]
    .sort((a, b) => a > b ? -1 : a < b ? 1 : 0);
  let remaining = amount;
  let count = 0n;
  let firstBatch = 0n;
  let slots = BigInt(TORNADO_MAX_SHIELD_NOTES);
  for (const denomination of denominations) {
    const used = remaining / denomination;
    remaining %= denomination;
    count += used;
    const take = used < slots ? used : slots;
    firstBatch += take * denomination;
    slots -= take;
  }
  if (remaining !== 0n || amount <= 0n) throw new Error("Tornado shield amount cannot be packed into supported pool denominations.");
  if (count <= BigInt(TORNADO_MAX_SHIELD_NOTES)) return;
  const fmt = (value: bigint) => `${formatUnits(value, asset.decimals)} ${asset.symbol}`;
  throw new Error(
    `Shielding ${fmt(amount)} requires ${count} deposit notes; this CLI allows at most ${TORNADO_MAX_SHIELD_NOTES} per Tornado shield through the public bundler. ` +
    `Use smaller amounts, for example ${fmt(firstBatch)} first (${TORNADO_MAX_SHIELD_NOTES} notes), then pack the remaining ${fmt(amount - firstBatch)} separately. ` +
    "Approvals do not count toward this limit. Smaller batches must still pass bundler simulation."
  );
}

/** Examples spendable by the SDK packer, using only this scheme's actual notes. */
export function tornadoAvailableAmounts(
  noteAmounts: readonly bigint[], target: bigint, asset: AssetLabel
): string {
  const counts = new Map<bigint, number>();
  for (const amount of noteAmounts) if (amount > 0n) counts.set(amount, (counts.get(amount) ?? 0) + 1);
  // Keep examples small without enumerating every subset of a large wallet.
  let sums = new Map<bigint, number>([[0n, 0]]);
  for (const [denomination, count] of counts) {
    const next = new Map(sums);
    for (const [sum, used] of sums) {
      for (let n = 1; n <= Math.min(count, TORNADO_MAX_SHIELD_NOTES - used); n++) {
        const value = sum + denomination * BigInt(n);
        next.set(value, Math.min(next.get(value) ?? Infinity, used + n));
      }
    }
    sums = next;
  }
  const notes = noteAmounts.filter((amount) => amount > 0n).map((amount) => ({ amount, balance: amount, pool: 0n }));
  const examples = [...sums.keys()].filter((sum) => sum > 0n).sort((a, b) => {
    const distanceA = a > target ? a - target : target - a;
    const distanceB = b > target ? b - target : target - b;
    return distanceA < distanceB ? -1 : distanceA > distanceB ? 1 : a < b ? -1 : 1;
  }).flatMap((sum) => {
    try {
      const count = selectTornadoWithdrawalNotes(notes, sum).length;
      return count <= TORNADO_MAX_SHIELD_NOTES
        ? [`${formatUnits(sum, asset.decimals)} ${asset.symbol} (${count} note${count === 1 ? "" : "s"})`] : [];
    } catch { return []; }
  }).slice(0, 6);
  return examples.length ? examples.join(", ") : "no spendable notes";
}

export function tornadoUnavailableAmountMessage(
  schemes: { signature: readonly bigint[]; legacy: readonly bigint[] },
  amount: bigint,
  asset: AssetLabel
): string {
  return `Cannot compose ${formatUnits(amount, asset.decimals)} ${asset.symbol} from whole Tornado notes in a single derivation scheme. ` +
    `Available amount examples before paymaster fees — signature: ${tornadoAvailableAmounts(schemes.signature, amount, asset)}; ` +
    `legacy: ${tornadoAvailableAmounts(schemes.legacy, amount, asset)}. ` +
    "Notes from different schemes cannot be combined; --exclude-new-pools also restricts which notes can be spent. Amount examples do not guarantee bundler acceptance.";
}
