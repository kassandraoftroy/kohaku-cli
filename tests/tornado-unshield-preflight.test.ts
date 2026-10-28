import assert from "node:assert/strict";
import { it } from "node:test";
import { preflightTornadoUnshield } from "../src/utils/tornado-unshield-preflight.js";
import type { SerializedUserOperation } from "../src/utils/tornado-paymaster-broadcaster.js";

function prepared() {
  const userOperation: SerializedUserOperation = {
    sender: "0x0000000000000000000000000000000000000001", nonce: "0x0", callData: "0x",
    callGasLimit: "0x0", verificationGasLimit: "0xc350", preVerificationGas: "0x186a0",
    maxFeePerGas: "0x1", maxPriorityFeePerGas: "0x1", signature: "0x1234",
    paymaster: "0x0000000000000000000000000000000000000002", paymasterData: "0xabcd",
    paymasterVerificationGasLimit: "0x6ddd0", paymasterPostOpGasLimit: "0xc350",
  };
  return { withdrawals: [{ mode: "paymaster" as const, bundlerUrl: "unused", entryPointAddress: "0x0000000000000000000000000000000000000003" as const, userOperation }] };
}

it("catches the reported preVerificationGas mismatch without modifying the signed operation", async () => {
  const operation = prepared();
  const original = structuredClone(operation);
  await assert.rejects(preflightTornadoUnshield(operation, async () => ({ preVerificationGas: "0x44aac" })), /signed preVerificationGas is 100000.*requires 281260.*fee, proof and signature/);
  assert.deepEqual(operation, original);
});

it("accepts valid gas budgets and preserves zero execution gas for direct withdrawals", async () => {
  const operation = prepared();
  await preflightTornadoUnshield(operation, async (withdrawal) => {
    assert.equal(withdrawal.userOperation, operation.withdrawals[0].userOperation);
    return { preVerificationGas: "0x186a0", callGasLimit: "0x5208", paymasterVerificationGasLimit: "0x6ddd0" };
  });
});

it("checks execution gas when there are tail calls", async () => {
  const operation = prepared();
  operation.withdrawals[0].userOperation.callData = "0x1234";
  await assert.rejects(preflightTornadoUnshield(operation, async () => ({ preVerificationGas: "0x186a0", callGasLimit: "0x1" })), /signed callGasLimit is 0.*requires 1/);
});

it("fails closed with a compact actionable error if SDK estimation fallback masked a failure", async () => {
  const error = Object.assign(new Error("Request failed\nRequest body: secret payload"), { details: "preVerificationGas is not enough, required: 281260, got: 100000" });
  await assert.rejects(preflightTornadoUnshield(prepared(), async () => { throw error; }), (error: Error) => {
    assert.match(error.message, /preflight failed before broadcast.*required: 281260/);
    assert.match(error.message, /No operation was submitted/);
    assert.doesNotMatch(error.message, /secret payload/);
    return true;
  });
});

it("rejects missing prepared withdrawals and incomplete estimates", async () => {
  await assert.rejects(preflightTornadoUnshield({}), /missing.*withdrawals/);
  await assert.rejects(preflightTornadoUnshield(prepared(), async () => ({})), /no usable preVerificationGas/);
  await assert.rejects(preflightTornadoUnshield(prepared(), async () => ({ preVerificationGas: "0x0" })), /no usable preVerificationGas/);
});

it("preflights the exact serialized operation through estimation only", async () => {
  const originalFetch = globalThis.fetch;
  const operation = prepared();
  operation.withdrawals[0].bundlerUrl = "https://bundler.invalid";
  const requests: unknown[] = [];
  globalThis.fetch = async (_input, init) => {
    requests.push(JSON.parse(String(init?.body)));
    return Response.json({ jsonrpc: "2.0", id: 1, result: { preVerificationGas: "0x186a0", verificationGasLimit: "0xc350", callGasLimit: "0x0" } });
  };
  try {
    await preflightTornadoUnshield(operation);
    assert.equal(requests.length, 1);
    const request = requests[0] as { method: string; params: unknown[] };
    assert.equal(request.method, "eth_estimateUserOperationGas");
    assert.deepEqual(request.params, [operation.withdrawals[0].userOperation, operation.withdrawals[0].entryPointAddress]);
  } finally { globalThis.fetch = originalFetch; }
});
