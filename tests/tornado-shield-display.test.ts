import assert from "node:assert/strict";
import { it } from "node:test";
import { parseEther } from "viem";
import { tornadoPoolsForAsset } from "../src/utils/tornado-pools.js";
import { requireTornadoShieldPlan, tornadoShieldPlanLabel } from "../src/utils/tornado-shield-plans.js";
import { compactShieldFee, tornadoShieldConfirmation } from "../src/utils/tornado-shield-display.js";

const pools = tornadoPoolsForAsset(11155111n, { isEth: true });
const plan = requireTornadoShieldPlan(parseEther("2.75"), pools);
const opts = {
  plan, decimals: 18, symbol: "ETH", sender: "0xF3b13Db3b67b795954a8453D2fB6FF2B489d04AA",
  batches: [
    { amount: parseEther("2.7"), noteCount: 5, fee: parseEther("0.005740060109909247") },
    { amount: parseEther("0.05"), noteCount: 3, fee: parseEther("0.006168049981020909") },
  ],
};

it("keeps a mixed eight-note packing on a short line with one currency label", () => {
  assert.equal(tornadoShieldPlanLabel(plan, 18, "ETH"), "2×1 + 2×0.3* + 0.1 + 0.03* + 2×0.01* ETH · 8 notes · 2 txs");
});

it("keeps full addresses and exact shield amounts readable without long fee decimals", () => {
  const message = tornadoShieldConfirmation(opts);
  assert.match(message, /Shield 2.75 ETH\?/);
  assert.ok(message.includes(opts.sender));
  for (const { pool } of plan.entries) assert.ok(message.includes(pool.poolAddress));
  assert.match(message, /Tx 1: 2.7 ETH · 5 notes · fee ~0.005741 ETH/);
  assert.match(message, /Tx 2: 0.05 ETH · 3 notes · fee ~0.006169 ETH/);
  assert.match(message, /Total est. fee: ~0.011909 ETH/);
  assert.match(message, /Partial completion/);
  assert.equal(message.split("* = new pool").length - 1, 1);
  assert.ok(message.split("\n").every((line) => line.length <= 80));
});

it("rounds estimates upward without losing wei precision, and labels skipped estimates unknown", () => {
  assert.equal(compactShieldFee(1n), "~0.000001 ETH");
  assert.equal(compactShieldFee(parseEther("0.001")), "~0.001 ETH");
  const message = tornadoShieldConfirmation({ ...opts, feesUnknown: true });
  assert.match(message, /fee unknown \(simulation skipped\)/);
  assert.ok(!message.includes("~"));
});
