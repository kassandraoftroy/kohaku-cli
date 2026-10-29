import assert from "node:assert/strict";
import { it } from "node:test";
import { tornadoAvailableAmounts, tornadoUnavailableAmountMessage } from "../src/utils/tornado-operation-limits.js";

const eth = { isEth: true, tokenAddress: "", symbol: "ETH", decimals: 18 };
const unit = 10n ** 16n;

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
  assert.match(result, /nearest below: 0.3 ETH \(1 note, signature\)/);
  assert.doesNotMatch(result, /0.31 ETH \(2 notes\)/);
  assert.match(result, /before paymaster fees/);
});
