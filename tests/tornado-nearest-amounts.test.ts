import assert from "node:assert/strict";
import { it } from "node:test";
import { parseEther } from "viem";
import { tornadoNearestAmounts } from "../src/utils/tornado-operation-limits.js";
import { tornadoSchemeCanCover } from "../src/utils/plugins.js";

it("offers 2.02 below and 3 above a 2.1 ETH request from actual notes", () => {
  const notes = ["1", "1", "1", "0.01", "0.01"].map((value) => parseEther(value));
  const near = tornadoNearestAmounts({ signature: notes, legacy: [] }, parseEther("2.1"));
  assert.deepEqual(near.lower, { amount: parseEther("2.02"), noteCount: 4, scheme: "signature" });
  assert.deepEqual(near.upper, { amount: parseEther("3"), noteCount: 3, scheme: "signature" });
});
it("has no shield note limit and never mixes derivation schemes", () => {
  const notes = [...Array(3).fill(parseEther("1")), ...Array(30).fill(parseEther("0.01"))] as bigint[];
  const near = tornadoNearestAmounts({ signature: notes, legacy: [parseEther("0.3")] }, parseEther("2.315"));
  assert.equal(near.lower!.amount, parseEther("2.3"));
  assert.equal(near.lower!.noteCount, 32);
  assert.equal(near.upper!.amount, parseEther("3"));
  const separated = tornadoNearestAmounts({ signature: [30n], legacy: [1n] }, 31n);
  assert.equal(separated.lower!.amount, 30n);
  assert.equal(separated.upper, undefined);
});
it("matches exhaustive SDK selection for bounded notes, including non-canonical denominations", () => {
  for (let a = 0; a <= 3; a++) for (let b = 0; b <= 3; b++) for (let c = 0; c <= 3; c++) {
    const notes = [...Array(a).fill(7n), ...Array(b).fill(4n), ...Array(c).fill(3n)] as bigint[];
    const total = notes.reduce((sum, note) => sum + note, 0n);
    const accepted: bigint[] = [];
    for (let value = 1n; value <= total; value++) if (tornadoSchemeCanCover(notes, value)) accepted.push(value);
    for (let target = 1n; target <= total + 1n; target++) {
      const near = tornadoNearestAmounts({ signature: notes, legacy: [] }, target);
      assert.equal(near.lower?.amount, accepted.filter((value) => value < target).at(-1));
      assert.equal(near.upper?.amount, accepted.find((value) => value > target));
    }
  }
});
it("handles large balances without subset-sum expansion and prefers legacy on ties", () => {
  const notes = Array(100).fill(10n ** 25n) as bigint[];
  const near = tornadoNearestAmounts({ signature: notes, legacy: notes }, 55n * 10n ** 25n + 1n);
  assert.equal(near.lower!.amount, 55n * 10n ** 25n);
  assert.equal(near.upper!.amount, 56n * 10n ** 25n);
  assert.equal(near.lower!.scheme, "legacy");
});
it("offers only single-note alternatives when the recipient cannot execute multi-note withdrawals", () => {
  const near = tornadoNearestAmounts({ signature: [1n, 1n, 1n, 10n], legacy: [4n] }, 3n, true);
  assert.equal(near.lower!.amount, 1n);
  assert.equal(near.upper!.amount, 4n);
  assert.equal(near.upper!.noteCount, 1);
});
