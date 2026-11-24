import assert from "node:assert/strict";
import { test } from "node:test";
import { parseEther } from "viem";
import { minimumTornadoNoteSumCovering, tornadoSchemeCanCover, tornadoWithdrawalCountForAmount } from "../src/utils/plugins.js";
import { tornadoNoteSelection } from "../src/utils/tornado-note-selection.js";
import { tornadoNearestAmounts } from "../src/utils/tornado-operation-limits.js";
import { selectTornadoWithdrawalNotes } from "../src/utils/tornado-unshield-pools.js";

test("Tornado exact selection recovers four 0.03 ETH notes behind a 0.1 ETH note", () => {
  const amounts = ["0.1", "0.03", "0.03", "0.03", "0.03"].map((amount) => parseEther(amount));
  const target = parseEther("0.12");
  assert.equal(tornadoSchemeCanCover(amounts, target), true);
  assert.equal(tornadoWithdrawalCountForAmount(amounts, target), 4);
  assert.equal(minimumTornadoNoteSumCovering(amounts, parseEther("0.115")), target);
  const notes = amounts.map((amount, index) => ({ amount, balance: amount, pool: BigInt(index + 1) }));
  assert.deepEqual(selectTornadoWithdrawalNotes(notes, target), notes.slice(1));
  const alternatives = tornadoNearestAmounts({ legacy: [], signature: amounts }, parseEther("0.125"));
  assert.deepEqual(alternatives.lower, { amount: target, noteCount: 4, scheme: "signature" });
  assert.deepEqual(alternatives.upper, { amount: parseEther("0.13"), noteCount: 2, scheme: "signature" });
});

test("Tornado selection retains the SDK's largest-first preference for existing exact sums", () => {
  assert.equal(tornadoWithdrawalCountForAmount([10n, 3n, 3n, 3n, 1n], 10n), 1);
  assert.equal(tornadoWithdrawalCountForAmount([7n, 4n, 3n, 3n], 10n), 2);
  assert.throws(() => tornadoWithdrawalCountForAmount([10n], 0n), /positive/);
  assert.throws(() => tornadoWithdrawalCountForAmount([10n], -1n), /positive/);
});

test("bounded note selection matches an independent exhaustive whole-note oracle", () => {
  for (let a = 0; a <= 3; a++) for (let b = 0; b <= 3; b++) for (let c = 0; c <= 3; c++) {
    const notes = [...Array(a).fill(7n), ...Array(b).fill(4n), ...Array(c).fill(3n)] as bigint[];
    const exact = new Map<bigint, number>();
    // Descending counts reproduce the SDK's preference among exact combinations.
    for (let i = a; i >= 0; i--) for (let j = b; j >= 0; j--) for (let k = c; k >= 0; k--) {
      const amount = 7n * BigInt(i) + 4n * BigInt(j) + 3n * BigInt(k);
      if (!exact.has(amount)) exact.set(amount, i + j + k);
    }
    const sums = [...exact.keys()].sort((x, y) => x < y ? -1 : x > y ? 1 : 0);
    const total = notes.reduce((sum, note) => sum + note, 0n);
    for (let target = 0n; target <= total + 1n; target++) {
      const expected = sums.filter((amount) => amount <= target).at(-1)!;
      const actual = tornadoNoteSelection(notes, target);
      assert.equal(actual.amount, expected);
      assert.equal(actual.noteCount, exact.get(expected));
      assert.equal([...actual.counts].reduce((sum, [amount, count]) => sum + amount * BigInt(count), 0n), expected);
      if (target > 0n && target <= total) {
        assert.equal(minimumTornadoNoteSumCovering(notes, target), sums.find((amount) => amount >= target));
      }
    }
  }
});
