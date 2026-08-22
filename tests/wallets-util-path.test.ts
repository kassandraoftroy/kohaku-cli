import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  parseRequiredWalletName,
  resolveWalletDir,
  walletNameToDirSegment,
} from "../src/utils/wallets-util.js";

describe("parseRequiredWalletName", () => {
  it("trims and treats blank as missing", () => {
    assert.equal(parseRequiredWalletName(" alice "), "alice");
    assert.equal(parseRequiredWalletName(undefined), null);
    assert.equal(parseRequiredWalletName("   "), null);
  });
});

describe("walletNameToDirSegment", () => {
  it("replaces unsafe characters without allowing path traversal", () => {
    assert.equal(walletNameToDirSegment("alice"), "alice");
    assert.equal(walletNameToDirSegment("My Wallet"), "My_Wallet");
    assert.equal(walletNameToDirSegment("../etc/passwd"), ".._etc_passwd");
    assert.equal(walletNameToDirSegment("/tmp/foo"), "tmp_foo");
  });

  it("rejects empty or punctuation-only names", () => {
    assert.throws(() => walletNameToDirSegment(""), /cannot be empty/);
    assert.throws(
      () => walletNameToDirSegment("   "),
      /cannot be empty/
    );
    assert.throws(
      () => walletNameToDirSegment("///"),
      /must contain at least one letter/
    );
  });
});

describe("resolveWalletDir", () => {
  it("joins the sanitized segment onto the data dir", () => {
    const dir = resolveWalletDir("/data", "My Wallet");
    assert.ok(dir.endsWith("My_Wallet"));
    assert.equal(dir.includes("My Wallet"), false);
  });
});
