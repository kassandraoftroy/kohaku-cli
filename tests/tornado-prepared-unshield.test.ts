import assert from "node:assert/strict";
import { it } from "node:test";
import { tornadoPreparedFee, tornadoPreparedSender, tornadoEstimationWarning } from "../src/utils/tornado-prepared-unshield.js";
import { buildFeePreview } from "../src/utils/fee-preview.js";

const sender = "0x0000000000000000000000000000000000000001" as const;
function prepared(fee: bigint) {
  return { withdrawals: [{ fee, proof: { args: ["0x1", "0x2", sender, "0x3", `0x${fee.toString(16)}`, "0x0"] }, userOperation: { sender } }] };
}

it("displays the actual proof-bound native fee, including a larger fallback fee", () => {
  const operation = prepared(5_000_000_000_000_000n);
  const fees = buildFeePreview({ kind: "tornado-paymaster", amount: tornadoPreparedFee(operation), decimals: 18, asset: "ETH" });
  assert.equal(fees.estimatedMax, "5000000000000000");
  assert.equal(fees.estimatedMaxFormatted, "0.005 ETH");
  assert.equal(tornadoPreparedSender(operation), sender);
});

it("uses the proof's token fee directly without another TWAP quote or fee pad", () => {
  const operation = prepared(123_456n);
  const fees = buildFeePreview({ kind: "tornado-paymaster", amount: tornadoPreparedFee(operation), decimals: 6, asset: "USDC" });
  assert.equal(fees.estimatedMaxFormatted, "0.123456 USDC");
});

it("supports older proof-only fee payloads and sums fees across withdrawals", () => {
  const operation = { withdrawals: [{ proof: { args: [0, 0, 0, 0, "0x64"] } }, ...prepared(200n).withdrawals] };
  assert.equal(tornadoPreparedFee(operation), 300n);
});

it("rejects missing or inconsistent fees rather than displaying a static estimate", () => {
  assert.throws(() => tornadoPreparedFee({}), /missing.*withdrawals/);
  assert.throws(() => tornadoPreparedFee({ withdrawals: [{ fee: 100n }] }), /missing.*proof-bound fee/);
  const operation = prepared(100n);
  operation.withdrawals[0].fee = 200n;
  assert.throws(() => tornadoPreparedFee(operation), /does not match its proof/);
  assert.throws(() => tornadoPreparedFee({ withdrawals: [{ proof: { args: [0, 0, 0, 0, -1n] } }] }), /does not match its proof/);
});

it("only warns for explicit fallback preparation and does not echo raw bundler errors", () => {
  assert.equal(tornadoEstimationWarning([{ status: "estimated" }]), undefined);
  const warning = tornadoEstimationWarning([{ status: "fallback", reason: "bundler-internal", message: "Request body: sensitive proof" }]);
  assert.match(warning!, /conservative fallback.*rejected.*funds.*sender/);
  assert.doesNotMatch(warning!, /sensitive proof/);
});
