import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  parseUnshieldAmount,
  privacyPoolsRelayerFeeWei,
} from "../src/lib/unshield-flow.js";

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

describe("privacyPoolsRelayerFeeWei", () => {
  it("returns null when the prepared op has no relay fee", () => {
    assert.equal(privacyPoolsRelayerFeeWei({}, 10_000n), null);
    assert.equal(privacyPoolsRelayerFeeWei(null, 10_000n), null);
  });

  it("computes amount * bps / 10000", () => {
    const prepared = { rawData: { relayData: { relayFeeBps: 25 } } };
    assert.deepEqual(privacyPoolsRelayerFeeWei(prepared, 10_000n), {
      relayFeeBps: 25n,
      feeWei: 25n,
    });
  });

  it("accepts a string relayFeeBps from JSON-like payloads", () => {
    const prepared = { rawData: { relayData: { relayFeeBps: "100" } } };
    assert.deepEqual(privacyPoolsRelayerFeeWei(prepared, 10_000n), {
      relayFeeBps: 100n,
      feeWei: 100n,
    });
  });
});
