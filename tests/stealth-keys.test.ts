import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { deriveStealthKeypair } from "../src/lib/stealth/keys.js";
import {
  STEALTH_SPENDING_PATH,
  STEALTH_VIEWING_PATH,
} from "../src/lib/stealth/constants.js";

const MNEMONIC =
  "test test test test test test test test test test test junk";

const MAINNET = {
  spendingPrivateKey:
    "0xf479f0cd06fda1a64f9396262b70f1da9091b040ffab3ea5d328cf26386efdc0",
  viewingPrivateKey:
    "0xae9338e966e7ba84db65064a2ac6d6f0e6ca1c00bd2853a1fb45acafea3437de",
  spendingPublicKey:
    "0x035c121b62d407c9a3ba672628785cd1fb07fb77aca6f31b20a4f9301dbbc051b5",
  viewingPublicKey:
    "0x037c69e66586e2768e8693328755e464b8b9d555e744d7c1ce2357554746ee8c4f",
  stealthMetaAddress:
    "0x035c121b62d407c9a3ba672628785cd1fb07fb77aca6f31b20a4f9301dbbc051b5037c69e66586e2768e8693328755e464b8b9d555e744d7c1ce2357554746ee8c4f",
  stealthMetaAddressURI:
    "st:eth:0x035c121b62d407c9a3ba672628785cd1fb07fb77aca6f31b20a4f9301dbbc051b5037c69e66586e2768e8693328755e464b8b9d555e744d7c1ce2357554746ee8c4f",
} as const;

describe("deriveStealthKeypair", () => {
  it("derives a stable spending/viewing pair from the junk mnemonic", () => {
    const keys = deriveStealthKeypair(MNEMONIC, 1n);
    assert.deepEqual(keys, MAINNET);
    assert.equal(STEALTH_SPENDING_PATH, "m/44'/60'/0'/5564'/1'/0'");
    assert.equal(STEALTH_VIEWING_PATH, "m/44'/60'/0'/5564'/1'/1'");
  });

  it("changes the URI chain prefix without changing the keys", () => {
    const mainnet = deriveStealthKeypair(MNEMONIC, 1n);
    const sepolia = deriveStealthKeypair(MNEMONIC, 11155111n);
    assert.equal(sepolia.spendingPrivateKey, mainnet.spendingPrivateKey);
    assert.equal(sepolia.viewingPrivateKey, mainnet.viewingPrivateKey);
    assert.equal(sepolia.stealthMetaAddress, mainnet.stealthMetaAddress);
    assert.equal(
      sepolia.stealthMetaAddressURI,
      "st:sep:0x035c121b62d407c9a3ba672628785cd1fb07fb77aca6f31b20a4f9301dbbc051b5037c69e66586e2768e8693328755e464b8b9d555e744d7c1ce2357554746ee8c4f"
    );
    assert.notEqual(sepolia.stealthMetaAddressURI, mainnet.stealthMetaAddressURI);
  });
});
