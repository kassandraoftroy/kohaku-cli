import assert from "node:assert/strict";
import {
  createPublicClient,
  custom,
  isAddressEqual,
  recoverTypedDataAddress,
  verifyTypedData,
} from "viem";
import { foundry } from "viem/chains";

import { createKeycardAccount } from
  "../src/utils/keycard-account.ts";

import { signOfflineEip7702BatchUserOperation } from
  "../src/utils/eip7702-batch-userop.ts";

const hardware = createKeycardAccount({
  binary: process.env.KOHAKU_KEYCARD_CLI,
});

let rpcCalls = 0;
let signingCalls = 0;
let capturedTypedData;

const owner = {
  ...hardware,

  async signTypedData(typedData) {
    signingCalls++;
    capturedTypedData = typedData;
    return hardware.signTypedData(typedData);
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

console.log("Hardware owner:", hardware.address);
console.log("Chain:", foundry.id);

console.log("=== Offline batched UserOperation ===");

const result = await signOfflineEip7702BatchUserOperation({
  client,
  owner,
  senderAddress: hardware.address,
  chainId: foundry.id,

  calls: [
    {
      to: hardware.address,
      data: "0x",
      value: 0n,
    },
    {
      to: hardware.address,
      data: "0x",
      value: 0n,
    },
  ],

  nonce: 0n,
  callGasLimit: 100_000n,
  verificationGasLimit: 200_000n,
  preVerificationGas: 40_000n,
  maxFeePerGas: 1_000_000_000n,
  maxPriorityFeePerGas: 100_000_000n,
});

const operation = result.userOperation;

assert.ok(isAddressEqual(
  operation.sender,
  hardware.address,
));

assert.match(
  result.entryPointAddress,
  /^0x[0-9a-fA-F]{40}$/,
);

assert.match(
  operation.signature,
  /^0x[0-9a-fA-F]{130}$/,
);

assert.equal(signingCalls, 1);
assert.ok(capturedTypedData);

console.log("PASS: Batched UserOperation signed by Keycard");

const recovered = await recoverTypedDataAddress({
  ...capturedTypedData,
  signature: operation.signature,
});

assert.ok(isAddressEqual(
  recovered,
  hardware.address,
));

console.log("Recovered:", recovered);
console.log("PASS: Hardware signer recovered");

assert.equal(
  await verifyTypedData({
    ...capturedTypedData,
    address: hardware.address,
    signature: operation.signature,
  }),
  true,
);

console.log("PASS: Signature verified");

assert.equal(
  await verifyTypedData({
    ...capturedTypedData,
    domain: {
      ...capturedTypedData.domain,
      chainId: 31338,
    },
    address: hardware.address,
    signature: operation.signature,
  }),
  false,
);

console.log("PASS: Modified chain rejected");

assert.equal(rpcCalls, 0);

console.log("PASS: Zero RPC requests");
console.log("PASS: No bundler submission");
console.log("PASS: Reusable Kohaku CLI hardware signer");
