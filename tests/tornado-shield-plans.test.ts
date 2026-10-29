import assert from "node:assert/strict";
import { it } from "node:test";
import { parseEther } from "viem";
import { tornadoPoolsForAsset } from "../src/utils/tornado-pools.js";
import { excludedTornadoDenominations, requireTornadoShieldPlan, tornadoShieldPlans, tornadoShieldChoices } from "../src/utils/tornado-shield-plans.js";

for (const chainId of [1n, 11155111n]) {
  const pools = tornadoPoolsForAsset(chainId, { isEth: true });
  it(`offers efficient and classic 1.4 ETH packings on ${chainId}`, () => {
    const choices = tornadoShieldChoices(tornadoShieldPlans(parseEther("1.4"), pools));
    assert.equal(choices[0]!.noteCount, 3);
    const classic = choices.find((plan) => plan.entries.every(({ pool }) => !pool.isNew))!;
    assert.ok(classic);
    assert.equal(classic.noteCount, 5);
    assert.equal(classic.batchCount, 2);
    assert.deepEqual(classic.entries.map(({ pool, count }) => [pool.denomination, count]), [[parseEther("1"), 1], [parseEther("0.1"), 4]]);
  });
  it(`excludes only 3 ETH and permits six notes across two batches on ${chainId}`, () => {
    const excluded = excludedTornadoDenominations(["3", "3.0"], 18, pools);
    assert.deepEqual(excluded, [parseEther("3")]);
    const allowed = pools.filter((pool) => !excluded.includes(pool.denomination));
    const plan = requireTornadoShieldPlan(parseEther("3.5"), allowed);
    assert.equal(plan.noteCount, 6);
    assert.equal(plan.batchCount, 2);
    assert.equal(plan.entries[0]!.pool.denomination, parseEther("1"));
    assert.equal(plan.entries[0]!.count, 3);
    assert.throws(() => requireTornadoShieldPlan(parseEther("3.5"), allowed, true), /four deposit notes/);
  });
  it(`finds an exact restricted packing even when greedy over the entire catalog fails on ${chainId}`, () => {
    const allowed = pools.filter((pool) => [parseEther("1"), parseEther("0.3")].includes(pool.denomination));
    const plan = requireTornadoShieldPlan(parseEther("1.2"), allowed);
    assert.equal(plan.noteCount, 4);
    assert.deepEqual(plan.entries.map(({ pool, count }) => [pool.denomination, count]), [[parseEther("0.3"), 4]]);
    assert.throws(() => requireTornadoShieldPlan(parseEther("0.2"), allowed), /No exact/);
  });
  it(`minimizes notes when the optimum requires a non-greedy count of the largest pool on ${chainId}`, () => {
    const allowed = pools.filter((pool) => [parseEther("1"), parseEther("0.3"), parseEther("0.01")].includes(pool.denomination));
    const plan = requireTornadoShieldPlan(parseEther("2.2"), allowed);
    assert.equal(plan.noteCount, 5);
    assert.deepEqual(plan.entries.map(({ pool, count }) => [pool.denomination, count]), [[parseEther("1"), 1], [parseEther("0.3"), 4]]);
  });
}
it("validates exclusion syntax, precision, chain and token denominations", () => {
  const pools = tornadoPoolsForAsset(1n, { isEth: true });
  for (const bad of ["0", "-1", "1e0", "0.123", "0.0100000000000000001"]) {
    assert.throws(() => excludedTornadoDenominations([bad], 18, pools));
  }
});
it("does not enumerate gigantic note arrays while searching", () => {
  const pools = tornadoPoolsForAsset(1n, { isEth: true });
  assert.throws(() => requireTornadoShieldPlan(10n ** 80n, pools), /No exact/);
});
it("matches exhaustive minimum-note DP across denomination exclusions", () => {
  const catalog = tornadoPoolsForAsset(1n, { isEth: true });
  const unit = parseEther("0.01");
  const sizes = [1, 3, 10, 30, 100];
  for (let mask = 1; mask < 32; mask++) {
    const allowed = sizes.filter((_, index) => mask & (1 << index));
    const pools = catalog.filter((pool) => allowed.includes(Number(pool.denomination / unit)));
    const dp = Array(61).fill(Infinity) as number[]; dp[0] = 0;
    for (let value = 1; value <= 60; value++) {
      for (const size of allowed) if (size <= value) dp[value] = Math.min(dp[value]!, dp[value - size]! + 1);
      if (dp[value] === Infinity) assert.throws(() => requireTornadoShieldPlan(BigInt(value) * unit, pools));
      else assert.equal(requireTornadoShieldPlan(BigInt(value) * unit, pools).noteCount, dp[value]);
    }
  }
});
