import assert from "node:assert/strict";
import { it } from "node:test";
import { toSimple7702SmartAccount } from "viem/account-abstraction";
import {
  privateKeyToAccount,
  toAccount,
  type PrivateKeyAccount,
} from "viem/accounts";
import { sepolia } from "viem/chains";
import { createPublicClient, http, type Hex } from "viem";
import { resolveEip7702Owner } from "../src/utils/eip7702-batch-userop.js";

it("delegates EIP-7702 UserOp signing to an external account", async () => {
  const software = privateKeyToAccount(
    "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
  );

  let typedDataCalls = 0;

  const hardwareMock = toAccount({
    address: software.address,
    signAuthorization: (args) => software.signAuthorization(args),
    signMessage: (args) => software.signMessage(args),
    signTransaction: (tx, options) =>
      software.signTransaction(tx, options),
    async signTypedData(args) {
      typedDataCalls++;
      return software.signTypedData(args);
    },
  });

  const owner = resolveEip7702Owner({
    owner: hardwareMock,
    senderAddress: software.address,
  });

  const smartAccount = await toSimple7702SmartAccount({
    client: createPublicClient({
      chain: sepolia,
      transport: http("http://127.0.0.1:8545"),
    }),
    owner: owner as PrivateKeyAccount,
  });

  const signature = await smartAccount.signUserOperation({
    sender: owner.address,
    nonce: 0n,
    callData: "0x",
    callGasLimit: 21000n,
    verificationGasLimit: 100000n,
    preVerificationGas: 50000n,
    maxFeePerGas: 1n,
    maxPriorityFeePerGas: 1n,
    signature: "0x",
  });

  assert.equal(typedDataCalls, 1);
  assert.match(signature as Hex, /^0x[0-9a-f]{130}$/);
});

it("delegates EIP-7702 authorization signing to an external account", async () => {
  const software = privateKeyToAccount(
    "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
  );

  let authorizationCalls = 0;

  const hardwareMock = toAccount({
    address: software.address,

    async signAuthorization(args) {
      authorizationCalls++;
      return software.signAuthorization(args);
    },

    signMessage: (args) => software.signMessage(args),
    signTransaction: (tx, options) =>
      software.signTransaction(tx, options),
    signTypedData: (args) => software.signTypedData(args),
  });

  const owner = resolveEip7702Owner({ owner: hardwareMock });

  const authorization = await owner.signAuthorization({
    address: "0x0000000000000000000000000000000000000001",
    chainId: sepolia.id,
    nonce: 0,
  });

  assert.equal(authorizationCalls, 1);
  assert.match(authorization.r, /^0x[0-9a-f]{64}$/);
  assert.match(authorization.s, /^0x[0-9a-f]{64}$/);
});
