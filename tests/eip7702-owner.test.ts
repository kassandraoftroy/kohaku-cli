import assert from "node:assert/strict";
import { it } from "node:test";
import { privateKeyToAccount, toAccount } from "viem/accounts";
import { resolveEip7702Owner } from "../src/utils/eip7702-batch-userop.js";

const key =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

const software = privateKeyToAccount(key);

const hardwareStyle = toAccount({
  address: software.address,
  signAuthorization: (args) => software.signAuthorization(args),
  async signMessage() {
    throw new Error("Mock device");
  },
  async signTransaction() {
    throw new Error("Mock device");
  },
  async signTypedData() {
    throw new Error("Mock device");
  },
});

it("preserves software private-key owner resolution", () => {
  const owner = resolveEip7702Owner({ privateKey: key });
  assert.equal(owner.address, software.address);
});

it("accepts an external signer without a private key", () => {
  const owner = resolveEip7702Owner({ owner: hardwareStyle });
  assert.strictEqual(owner, hardwareStyle);
});

it("rejects missing signing inputs", () => {
  assert.throws(
    () => resolveEip7702Owner({}),
    /requires an owner/
  );
});

it("rejects conflicting signing inputs", () => {
  assert.throws(
    () => resolveEip7702Owner({
      owner: hardwareStyle,
      privateKey: key,
    }),
    /not both/
  );
});

it("rejects signers without authorization support", () => {
  const unsupported = toAccount({
    address: software.address,
    async signMessage() {
      throw new Error("Mock device");
    },
    async signTransaction() {
      throw new Error("Mock device");
    },
    async signTypedData() {
      throw new Error("Mock device");
    },
  });

  assert.throws(
    () => resolveEip7702Owner({ owner: unsupported }),
    /signAuthorization/
  );
});

it("rejects mismatched sender addresses", () => {
  assert.throws(
    () => resolveEip7702Owner({
      owner: hardwareStyle,
      senderAddress: "0x0000000000000000000000000000000000000001",
    }),
    /does not match sender/
  );
});
