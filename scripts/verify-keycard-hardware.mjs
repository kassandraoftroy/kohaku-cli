import assert from "node:assert/strict";
import {
  createWalletClient,
  custom,
  isAddressEqual,
  numberToHex,
  recoverMessageAddress,
  recoverTransactionAddress,
  verifyTypedData,
} from "viem";
import { foundry } from "viem/chains";
import { recoverAuthorizationAddress } from "viem/utils";
import { createKeycardAccount } from "../src/utils/keycard-account.ts";

const account = createKeycardAccount({
  binary: process.env.KOHAKU_KEYCARD_CLI,
});

const rpcCalls = [];

const wallet = createWalletClient({
  account,
  chain: foundry,
  transport: custom({
    async request({ method }) {
      rpcCalls.push(method);

      if (method === "eth_chainId") {
        return numberToHex(foundry.id);
      }

      throw new Error(`RPC forbidden: ${method}`);
    },
  }),
});

console.log("Keycard:", account.address);

// EIP-191
const message = "Kohaku CLI - hardware integration";

const messageSignature = await wallet.signMessage({
  message,
});

const messageSigner = await recoverMessageAddress({
  message,
  signature: messageSignature,
});

assert.ok(isAddressEqual(messageSigner, account.address));
console.log("PASS: EIP-191 hardware signing");

// EIP-712
const typedData = {
  domain: {
    name: "Kohaku CLI",
    version: "1",
    chainId: foundry.id,
  },
  types: {
    HardwareTest: [
      { name: "owner", type: "address" },
      { name: "nonce", type: "uint256" },
    ],
  },
  primaryType: "HardwareTest",
  message: {
    owner: account.address,
    nonce: 1n,
  },
};

const typedSignature = await wallet.signTypedData(typedData);

assert.equal(
  await verifyTypedData({
    ...typedData,
    address: account.address,
    signature: typedSignature,
  }),
  true,
);

console.log("PASS: EIP-712 hardware signing");

// EIP-1559
const transaction = {
  type: "eip1559",
  chainId: foundry.id,
  nonce: 0,
  to: account.address,
  value: 0n,
  gas: 21_000n,
  maxFeePerGas: 1_000_000_000n,
  maxPriorityFeePerGas: 100_000_000n,
  data: "0x",
  accessList: [],
};

const signedTransaction = await wallet.signTransaction(
  transaction,
);

const transactionSigner = await recoverTransactionAddress({
  serializedTransaction: signedTransaction,
});

assert.ok(
  isAddressEqual(transactionSigner, account.address),
);

console.log("PASS: EIP-1559 hardware signing");

// EIP-7702
const authorization = await wallet.signAuthorization({
  contractAddress: "0x1111111111111111111111111111111111111111",
  chainId: foundry.id,
  nonce: 4294967295,
});

const authorizationSigner = await recoverAuthorizationAddress({
  authorization,
});

assert.ok(
  isAddressEqual(authorizationSigner, account.address),
);

console.log("PASS: EIP-7702 hardware authorization");

// No network access permitted.
assert.ok(
  rpcCalls.every(method => method === "eth_chainId"),
);

console.log("PASS: No external RPC calls");
console.log("PASS: No transactions broadcast");
console.log("PASS: Kohaku CLI Keycard adapter verified");
