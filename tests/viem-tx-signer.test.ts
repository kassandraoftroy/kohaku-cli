import assert from "node:assert/strict";
import { it } from "node:test";
import { privateKeyToAccount, toAccount } from "viem/accounts";
import { sepolia } from "viem/chains";

import { makeWalletClient } from "../src/utils/viem-tx.js";
import type { KohakuPublicClient } from "../src/utils/rpc.js";

const privateKey =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

const softwareAccount = privateKeyToAccount(privateKey);
const publicClient = {
  chain: sepolia,
} as unknown as KohakuPublicClient;

const rpcUrl = "http://127.0.0.1:8545";

it("preserves software private-key signing", () => {
  const wallet = makeWalletClient(privateKey, publicClient, rpcUrl);

  assert.equal(wallet.account?.address, softwareAccount.address);
  assert.equal(wallet.account?.type, "local");
  assert.equal(wallet.chain?.id, sepolia.id);
});

it("accepts an existing viem account", () => {
  const wallet = makeWalletClient(
    softwareAccount,
    publicClient,
    rpcUrl
  );

  assert.strictEqual(wallet.account, softwareAccount);
});

it("accepts a custom hardware-style account without a private key", () => {
  const customAccount = toAccount({
    address: softwareAccount.address,

    async signMessage() {
      throw new Error("Mock hardware not connected");
    },

    async signTransaction() {
      throw new Error("Mock hardware not connected");
    },

    async signTypedData() {
      throw new Error("Mock hardware not connected");
    },
  });

  const wallet = makeWalletClient(
    customAccount,
    publicClient,
    rpcUrl
  );

  assert.strictEqual(wallet.account, customAccount);
  assert.equal(wallet.account?.address, customAccount.address);
  assert.equal(wallet.account?.type, "local");
});

it("delegates message signing to an injected account", async () => {
  let signingCalls = 0;
  const message = "kohaku-key signer delegation test";

  const hardwareStyleAccount = toAccount({
    address: softwareAccount.address,

    async signMessage(args) {
      signingCalls++;
      return softwareAccount.signMessage(args);
    },

    async signTransaction() {
      throw new Error("Not implemented in mock");
    },

    async signTypedData() {
      throw new Error("Not implemented in mock");
    },
  });

  const wallet = makeWalletClient(
    hardwareStyleAccount,
    publicClient,
    rpcUrl
  );

  const signature = await wallet.signMessage({
    account: hardwareStyleAccount,
    message,
  });

  assert.equal(signingCalls, 1);
  assert.equal(
    signature,
    await softwareAccount.signMessage({ message })
  );
});
