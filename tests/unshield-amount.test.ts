import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { privacyPoolsPreparedFee } from "../src/lib/privacy-pools-unshield.js";
import { parseUnshieldAmount } from "../src/lib/unshield-flow.js";

describe("parseUnshieldAmount", () => {
  it("accepts max regardless of case", () => {
    assert.equal(parseUnshieldAmount("max", 18, 123n), 123n);
    assert.equal(parseUnshieldAmount("MAX", 18, 123n), 123n);
    assert.equal(parseUnshieldAmount(" Max ", 18, 123n), 123n);
  });

  it("throws when max is requested but the hint is missing", () => {
    assert.throws(
      () => parseUnshieldAmount("max", 18, 0n),
      /Could not determine max unshield amount/
    );
  });

  it("parses a human amount at 18 decimals", () => {
    assert.equal(parseUnshieldAmount("1.5", 18, 0n), 1_500_000_000_000_000_000n);
  });

  it("parses a human amount at 6 decimals (USDC)", () => {
    assert.equal(parseUnshieldAmount("1.5", 6, 0n), 1_500_000n);
  });

  it("rejects zero and negative-looking zero", () => {
    assert.throws(() => parseUnshieldAmount("0", 18, 0n), /greater than zero/);
    assert.throws(() => parseUnshieldAmount("0.0", 6, 0n), /greater than zero/);
  });

  it("rejects an amount above the max hint when a hint is present", () => {
    assert.throws(
      () => parseUnshieldAmount("2", 18, 1_000_000_000_000_000_000n),
      /exceeds maximum/
    );
  });

  it("allows an exact max-hint amount", () => {
    const cap = 1_000_000n;
    assert.equal(parseUnshieldAmount("1", 6, cap), cap);
  });
});

describe("privacyPoolsPreparedFee", () => {
  it("returns null when the prepared op has no fee", () => {
    assert.equal(privacyPoolsPreparedFee({}), null);
    assert.equal(privacyPoolsPreparedFee({ withdrawal: {} }), null);
  });

  it("reads the paymaster withdrawal fee", () => {
    assert.equal(
      privacyPoolsPreparedFee({ withdrawal: { fee: 25n } }),
      25n
    );
  });

  it("falls back to the exact-output fee", () => {
    assert.equal(privacyPoolsPreparedFee({ exact: { fee: "100" } }), 100n);
  });
});
