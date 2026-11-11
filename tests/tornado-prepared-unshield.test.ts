import assert from "node:assert/strict";
import { it } from "node:test";
import { tornadoPreparedFee, tornadoPreparedSender, tornadoPreparedRefundRecipient, assertTornadoPreparedExecutor, assertTornadoPreparedDirectWithdrawal, tornadoEstimationWarning } from "../src/utils/tornado-prepared-unshield.js";
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

it("reads the sponsoring proof refund recipient independently of its executor", () => {
  const operation = prepared(100n);
  operation.withdrawals[0].proof.args[2] = "0x123";
  assert.equal(tornadoPreparedRefundRecipient(operation), "0x0000000000000000000000000000000000000123");
  assert.equal(tornadoPreparedRefundRecipient({ withdrawals: [{ proof: { args: [0n, 0n, 123n] } }] }),
    "0x000000000000000000000000000000000000007b");
  for (const value of ["invalid", -1n, 1n << 160n, undefined]) {
    assert.equal(tornadoPreparedRefundRecipient({ withdrawals: [{ proof: { args: [0n, 0n, value] } }] }), undefined);
  }
  assert.equal(tornadoPreparedRefundRecipient({}), undefined);
});

it("refuses to broadcast when any prepared sender differs from the reserved account", () => {
  const operation = prepared(100n);
  assertTornadoPreparedExecutor(operation, sender);
  assertTornadoPreparedExecutor({ withdrawals: [...operation.withdrawals, ...operation.withdrawals] }, sender);
  for (const invalid of [{}, { withdrawals: [] }, { withdrawals: [{}] },
    { withdrawals: [...operation.withdrawals, { userOperation: { sender: "0x0000000000000000000000000000000000000002" } }] }]) {
    assert.throws(() => assertTornadoPreparedExecutor(invalid, sender), /does not match.*reserved/);
  }
});

it("allows a temporary executor only for one direct payout with the intended refund recipient", () => {
  const recipient = "0x0000000000000000000000000000000000000009";
  const direct = { withdrawals: [{ mode: "paymaster", proof: { args: [0, 0, recipient] },
    userOperation: { sender, callData: "0x", callGasLimit: "0x0" } }] };
  assertTornadoPreparedDirectWithdrawal(direct, recipient);
  const invalid = [
    {}, { withdrawals: [] }, { withdrawals: [...direct.withdrawals, ...direct.withdrawals] },
    { withdrawals: [{ ...direct.withdrawals[0], mode: "relayer" }] },
    { withdrawals: [{ ...direct.withdrawals[0], proof: { args: [0, 0, sender] } }] },
    ...[{ callData: "0x1234", callGasLimit: "0x0" }, { callData: "0x", callGasLimit: "0x1" },
      { callData: "0x" }].map(op => ({ withdrawals: [{ ...direct.withdrawals[0], userOperation: op }] })),
  ];
  for (const operation of invalid) {
    assert.throws(() => assertTornadoPreparedDirectWithdrawal(operation, recipient), /temporary Tornado executor requires one direct withdrawal/);
  }
  const estimates = [{ status: "fallback", reason: "bundler-internal", message: "sensitive" }] as const;
  const warning = tornadoEstimationWarning(estimates, direct);
  assert.match(warning!, /conservative fallback/);
  assert.doesNotMatch(warning!, /funds.*sender|sensitive/);
});
