import assert from "node:assert/strict";
import { it } from "node:test";
import { entryPoint08Address, getUserOperationHash, formatUserOperationRequest, type UserOperation } from "viem/account-abstraction";
import { submitPreparedShieldUserOp } from "../src/utils/eip7702-submit.js";
const operation: UserOperation<"0.8"> = {
  sender: "0x0000000000000000000000000000000000000001", nonce: 1n, callData: "0x1234", callGasLimit: 1_000_000n,
  verificationGasLimit: 200_000n, preVerificationGas: 400_000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, signature: "0x1234",
};
const txHash = `0x${"11".repeat(32)}` as const;
const hash = getUserOperationHash({ chainId: 1, entryPointAddress: entryPoint08Address, entryPointVersion: "0.8", userOperation: operation });
const base = { chainId: 1n, entryPointAddress: entryPoint08Address, userOperation: operation };
it("persists the exact signed hash before the only send and waits for chain confirmation", async () => {
  const events: string[] = [];
  const result = await submitPreparedShieldUserOp({ ...base,
    onSubmitted: (value) => { assert.equal(value, hash); events.push("saved"); },
    send: async (request) => { assert.deepEqual(request, formatUserOperationRequest(operation)); events.push("sent"); return hash; },
    wait: async (value) => { assert.equal(value, hash); events.push("userop receipt"); return { success: true, receipt: { transactionHash: txHash } }; },
    confirm: async (value) => { assert.equal(value, txHash); events.push("chain receipt"); return { status: "success" }; },
  });
  assert.deepEqual(result, { userOpHash: hash, txHash });
  assert.deepEqual(events, ["saved", "sent", "userop receipt", "chain receipt"]);
});
it("does not send if persisting the hash fails", async () => {
  await assert.rejects(submitPreparedShieldUserOp({ ...base,
    onSubmitted: () => { throw new Error("disk full"); },
    send: async () => { assert.fail("must not send"); },
    wait: async () => { assert.fail("must not wait"); }, confirm: async () => { assert.fail("must not confirm"); },
  }), /disk full/);
});
it("on a lost send response only waits for the saved hash and never resends", async () => {
  let sends = 0;
  const result = await submitPreparedShieldUserOp({ ...base,
    send: async () => { sends++; throw new Error("HTTP request timed out"); },
    wait: async (value) => { assert.equal(value, hash); return { success: true, receipt: { transactionHash: txHash } }; },
    confirm: async () => ({ status: "success" }),
  });
  assert.equal(sends, 1); assert.equal(result.txHash, txHash);
});
it("does not continue past a failed UserOp or a reverted transaction", async () => {
  for (const userOpSuccess of [false, true]) {
    await assert.rejects(submitPreparedShieldUserOp({ ...base,
      send: async () => hash,
      wait: async () => ({ success: userOpSuccess, receipt: { transactionHash: txHash } }),
      confirm: async () => ({ status: userOpSuccess ? "reverted" : "success" }),
    }), (error: Error & { submissionStatus?: string; txHash?: string }) => {
      assert.equal(error.submissionStatus, "failed"); assert.equal(error.txHash, txHash); return true;
    });
  }
});
it("reports explicit RPC rejection separately from unknown transport/inclusion outcomes", async () => {
  await assert.rejects(submitPreparedShieldUserOp({ ...base,
    send: async () => { throw Object.assign(new Error("AA21 insufficient prefund"), { code: -32500 }); },
    wait: async () => { assert.fail("must not wait on rejected operation"); },
    confirm: async () => { assert.fail("must not confirm"); },
  }), (error: Error & { submissionStatus?: string }) => { assert.equal(error.submissionStatus, "failed"); return true; });
  await assert.rejects(submitPreparedShieldUserOp({ ...base,
    send: async () => hash,
    wait: async () => { throw new Error("receipt timeout"); },
    confirm: async () => { assert.fail("must not confirm"); },
  }), /receipt timeout/);
});
it("hashes and sends the same EIP-7702 authorization and factory fields", async () => {
  const authorized: UserOperation<"0.8"> = { ...operation, factory: "0x7702", factoryData: "0x",
    authorization: { address: "0xe6Cae83BdE06E4c305530e199D7217f42808555B", chainId: 1, nonce: 0,
      r: `0x${"01".repeat(32)}`, s: `0x${"02".repeat(32)}`, yParity: 0 } };
  const expected = getUserOperationHash({ chainId: 1, entryPointAddress: entryPoint08Address, entryPointVersion: "0.8", userOperation: authorized });
  assert.notEqual(expected, hash);
  await submitPreparedShieldUserOp({ ...base, userOperation: authorized,
    onSubmitted: (value) => assert.equal(value, expected),
    send: async (request) => {
      assert.equal(request.factory, "0x7702");
      assert.equal(request.eip7702Auth?.address, authorized.authorization!.address);
      assert.deepEqual(request, formatUserOperationRequest(authorized)); return expected;
    },
    wait: async (value) => { assert.equal(value, expected); return { success: true, receipt: { transactionHash: txHash } }; },
    confirm: async () => ({ status: "success" }),
  });
});
