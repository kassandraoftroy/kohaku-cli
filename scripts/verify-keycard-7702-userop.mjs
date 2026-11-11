import assert from "node:assert/strict";
import {
  createPublicClient,
  custom,
  isAddressEqual,
  recoverTypedDataAddress,
  verifyTypedData,
} from "viem";
import { foundry } from "viem/chains";
import { toSimple7702SmartAccount } from "viem/account-abstraction";

import { createKeycardAccount } from
  "../src/utils/keycard-account.ts";
import { resolveEip7702Owner } from
  "../src/utils/eip7702-batch-userop.ts";
import { SIMPLE_7702_IMPLEMENTATION } from
  "../src/utils/simple-7702.ts";

const hardware = createKeycardAccount({
  binary: process.env.KOHAKU_KEYCARD_CLI,
});

let rpcCalls = 0;
let typedDataCalls = 0;
let signedTypedData;

// Observe viem's delegation into the real hardware signer.
const observedOwner = {
  ...hardware,

  async signTypedData(typedData) {
    typedDataCalls++;
    signedTypedData = typedData;
    return hardware.signTypedData(typedData);
  },
};

console.log("=== Resolve Kohaku EIP-7702 owner ===");

const owner = resolveEip7702Owner({
  owner: observedOwner,
  senderAddress: hardware.address,
});

assert.ok(isAddressEqual(owner.address, hardware.address));
assert.equal(typeof owner.signAuthorization, "function");

console.log("PASS: External Keycard owner resolved");

const client = createPublicClient({
  chain: foundry,
  transport: custom({
    async request({ method }) {
      rpcCalls++;
      throw new Error(`RPC forbidden: ${method}`);
    },
  }),
});

console.log("=== Construct Kohaku Simple7702 account ===");

const account = await toSimple7702SmartAccount({
  client,
  owner,
  implementation: SIMPLE_7702_IMPLEMENTATION,
});

const sender = await account.getAddress();

assert.ok(isAddressEqual(sender, hardware.address));

console.log("Keycard owner:", hardware.address);
console.log("Simple7702 sender:", sender);

const callData = await account.encodeCalls([
  {
    to: hardware.address,
    value: 0n,
    data: "0x",
  },
]);

const operation = {
  sender,
  nonce: 0n,
  callData,
  callGasLimit: 100_000n,
  verificationGasLimit: 200_000n,
  preVerificationGas: 40_000n,
  maxFeePerGas: 1_000_000_000n,
  maxPriorityFeePerGas: 100_000_000n,
};

console.log("=== Sign UserOperation on physical Keycard ===");

const signature = await account.signUserOperation({
  ...operation,
  chainId: foundry.id,
});

assert.match(signature, /^0x[0-9a-fA-F]{130}$/);
assert.equal(typedDataCalls, 1);
assert.ok(signedTypedData);

console.log("PASS: UserOperation delegated to Keycard");

const recovered = await recoverTypedDataAddress({
  ...signedTypedData,
  signature,
});

assert.ok(isAddressEqual(recovered, hardware.address));

console.log("PASS: Hardware signature recovered");

assert.equal(
  await verifyTypedData({
    ...signedTypedData,
    address: hardware.address,
    signature,
  }),
  true,
);

console.log("PASS: UserOperation signature verified");

assert.equal(
  await verifyTypedData({
    ...signedTypedData,
    domain: {
      ...signedTypedData.domain,
      chainId: 31338,
    },
    address: hardware.address,
    signature,
  }),
  false,
);

console.log("PASS: Cross-chain modification rejected");

assert.equal(rpcCalls, 0);

console.log("PASS: Zero RPC calls");
console.log("PASS: No UserOperation broadcast");
console.log("PASS: Kohaku CLI Simple7702 hardware integration");
