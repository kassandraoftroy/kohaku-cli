import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createPublicClient,
  custom,
  verifyTypedData,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";

import {
  signOfflineEip7702BatchUserOperation,
} from "../src/utils/eip7702-batch-userop.ts";

// Publicly known disposable test key. Never fund this account.
const software = privateKeyToAccount(`0x${"11".repeat(32)}`);

function setup() {
  let rpcCalls = 0;
  let typedDataCalls = 0;
  let captured;

  const owner = {
    ...software,
    async signTypedData(data) {
      typedDataCalls++;
      captured = data;
      return software.signTypedData(data);
    },
  };

  const client = createPublicClient({
    chain: foundry,
    transport: custom({
      async request({ method }) {
        rpcCalls++;
        throw new Error(`RPC forbidden: ${method}`);
      },
    }),
  });

  const options = {
    client,
    owner,
    senderAddress: software.address,
    chainId: foundry.id,
    calls: [
      { to: software.address, data: "0x", value: 0n },
      { to: software.address, data: "0x", value: 0n },
    ],
    nonce: 0n,
    callGasLimit: 100_000n,
    verificationGasLimit: 200_000n,
    preVerificationGas: 40_000n,
    maxFeePerGas: 1_000_000_000n,
    maxPriorityFeePerGas: 100_000_000n,
  };

  return {
    options,
    stats: () => ({ rpcCalls, typedDataCalls, captured }),
  };
}

test("signs a batched Simple7702 operation offline", async () => {
  const { options, stats } = setup();

  const result = await signOfflineEip7702BatchUserOperation(
    options,
  );

  const signed = result.userOperation;
  const { captured, typedDataCalls, rpcCalls } = stats();

  assert.equal(signed.sender, software.address);
  assert.equal(signed.nonce, 0n);
  assert.match(signed.callData, /^0x[0-9a-fA-F]+$/);
  assert.match(signed.signature, /^0x[0-9a-fA-F]{130}$/);

  assert.equal(typedDataCalls, 1);
  assert.equal(rpcCalls, 0);

  assert.equal(
    await verifyTypedData({
      ...captured,
      address: software.address,
      signature: signed.signature,
    }),
    true,
  );

  assert.equal(
    await verifyTypedData({
      ...captured,
      domain: {
        ...captured.domain,
        chainId: 31338,
      },
      address: software.address,
      signature: signed.signature,
    }),
    false,
  );
});

test("rejects invalid chain ID before signing", async () => {
  const { options, stats } = setup();

  await assert.rejects(
    signOfflineEip7702BatchUserOperation({
      ...options,
      chainId: 31338,
    }),
    /chain ID mismatch/,
  );

  assert.equal(stats().typedDataCalls, 0);
  assert.equal(stats().rpcCalls, 0);
});

test("rejects invalid gas fees before signing", async () => {
  const { options, stats } = setup();

  await assert.rejects(
    signOfflineEip7702BatchUserOperation({
      ...options,
      maxPriorityFeePerGas: 2_000_000_000n,
    }),
    /Invalid offline UserOperation parameters/,
  );

  assert.equal(stats().typedDataCalls, 0);
  assert.equal(stats().rpcCalls, 0);
});

test("rejects an empty batch", async () => {
  const { options, stats } = setup();

  await assert.rejects(
    signOfflineEip7702BatchUserOperation({
      ...options,
      calls: [],
    }),
    /requires calls/,
  );

  assert.equal(stats().typedDataCalls, 0);
  assert.equal(stats().rpcCalls, 0);
});
