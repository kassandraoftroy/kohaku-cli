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
    assert.equal(walletNameToDirSegment("../etc/passwd"), ".._etc_passwd");
    assert.equal(walletNameToDirSegment("/tmp/foo"), "tmp_foo");
  });

  it("rejects names with spaces", () => {
    assert.throws(
      () => walletNameToDirSegment("My Wallet"),
      /cannot contain spaces/
    );
    assert.throws(
      () =>
        walletNameToDirSegment(
          "abandon ability able about above absent absorb abstract"
        ),
      /cannot contain spaces/
    );
  });

  it("rejects reserved data-dir names", () => {
    assert.throws(
      () => walletNameToDirSegment("proving-artifacts"),
      /reserved/
    );
    assert.throws(
      () => walletNameToDirSegment("Public-Sync-Cache"),
      /reserved/
    );
    assert.throws(
      () => walletNameToDirSegment("proving-artifacts/"),
      /reserved/
    );
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
    const dir = resolveWalletDir("/data", "alice");
    assert.ok(dir.endsWith("alice"));
  });
});
