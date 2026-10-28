import assert from "node:assert/strict";
import { it } from "node:test";
import { assertTornadoShieldNoteLimit, tornadoAvailableAmounts, tornadoUnavailableAmountMessage } from "../src/utils/tornado-operation-limits.js";

const eth = { isEth: true, tokenAddress: "", symbol: "ETH", decimals: 18 };
const unit = 10n ** 16n;

it("permits five shield notes and rejects six or more on both chains", () => {
  for (const chain of [1n, 11155111n]) {
    assert.doesNotThrow(() => assertTornadoShieldNoteLimit(chain, 234n * unit, eth));
    assert.throws(() => assertTornadoShieldNoteLimit(chain, 75n * unit, eth), /requires 6 deposit notes.*at most 5.*0.74 ETH.*remaining 0.01 ETH/);
    assert.throws(() => assertTornadoShieldNoteLimit(chain, 245n * unit, eth), /requires 7 deposit notes/);
    assert.doesNotThrow(() => assertTornadoShieldNoteLimit(chain, 1000n * unit, eth));
  }
});

it("counts the selected pool policy, rather than ETH size or total call count", () => {
  assert.doesNotThrow(() => assertTornadoShieldNoteLimit(1n, 240n * unit, eth));
  assert.throws(() => assertTornadoShieldNoteLimit(1n, 240n * unit, { ...eth, excludeNewPools: true }), /requires 6 deposit notes/);
  const dai = { isEth: false, tokenAddress: "0x6B175474E89094C44Da98b954EedeAC495271d0F", symbol: "DAI", decimals: 18 };
  // Five deposits may also need approvals; approvals aren't notes.
  assert.doesNotThrow(() => assertTornadoShieldNoteLimit(1n, 500n * 10n ** 18n, dai));
  assert.throws(() => assertTornadoShieldNoteLimit(1n, 600n * 10n ** 18n, dai), /requires 6 deposit notes/);
});

it("does not expand huge shield amounts into a note array", () => {
  assert.throws(() => assertTornadoShieldNoteLimit(1n, 10n ** 40n, eth), /at most 5/);
});

it("suggests amounts from actual note counts, not catalog denominations", () => {
  const result = tornadoAvailableAmounts([30n * unit, 30n * unit, 1n * unit], 20n * unit, eth);
  assert.match(result, /0.3 ETH \(1 note\)/);
  assert.match(result, /0.61 ETH \(3 notes\)/);
  assert.doesNotMatch(result, /0.2 ETH|0.1 ETH|0.02 ETH/);
  assert.equal(tornadoAvailableAmounts([], 1n, eth), "no spendable notes");
});

it("filters subset sums that the SDK's greedy note selector cannot compose", () => {
  const result = tornadoAvailableAmounts([4n, 3n, 3n], 6n, { symbol: "TEST", decimals: 0 });
  assert.doesNotMatch(result, /6 TEST/);
  assert.match(result, /7 TEST \(2 notes\)/);
});

it("keeps derivation schemes separate in amount guidance", () => {
  const result = tornadoUnavailableAmountMessage({ signature: [30n * unit], legacy: [1n * unit] }, 31n * unit, eth);
  assert.match(result, /signature: 0.3 ETH \(1 note\); legacy: 0.01 ETH \(1 note\)/);
  assert.doesNotMatch(result, /0.31 ETH \(2 notes\)/);
  assert.match(result, /before paymaster fees/);
});
