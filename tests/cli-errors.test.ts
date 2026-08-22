import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  formatCaughtError,
  withTorBootstrapHint,
} from "../src/utils/cli-errors.js";

describe("formatCaughtError", () => {
  it("returns primitives and strings as text", () => {
    assert.equal(formatCaughtError("boom"), "boom");
    assert.equal(formatCaughtError(null), "null");
    assert.equal(formatCaughtError(undefined), "undefined");
    assert.equal(formatCaughtError(3n), "3");
  });

  it("does not stringify a plain object as [object Object]", () => {
    const text = formatCaughtError({ message: "rpc failed", code: -32000 });
    assert.equal(text.includes("[object Object]"), false);
    assert.ok(text.includes("rpc failed"));
    assert.ok(text.includes("-32000"));
  });

  it("prefers Error.message and appends a cause", () => {
    const err = new Error("outer");
    err.cause = { message: "inner" };
    const text = formatCaughtError(err);
    assert.ok(text.startsWith("outer"));
    assert.ok(text.includes("cause:"));
    assert.ok(text.includes("inner"));
  });

  it("falls back to shortMessage when message is useless", () => {
    const err = new Error("[object Object]");
    (err as Error & { shortMessage: string }).shortMessage = "execution reverted";
    const text = formatCaughtError(err);
    assert.ok(text.includes("execution reverted"));
    assert.equal(text.includes("[object Object]"), false);
  });
});

describe("withTorBootstrapHint", () => {
  it("appends clear-tor-cache once on a bootstrap failure", () => {
    const msg = "Bootstrap failed: tor: timed out";
    const hinted = withTorBootstrapHint(msg);
    assert.ok(hinted.includes("kohaku clear-tor-cache"));
    assert.equal(withTorBootstrapHint(hinted), hinted);
  });

  it("leaves unrelated errors alone", () => {
    assert.equal(withTorBootstrapHint("insufficient funds"), "insufficient funds");
  });
});
