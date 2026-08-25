import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { formatUsdCents } from "../src/lib/usd-values.js";
import { jsonStringifyWithBigInt } from "../src/utils/json-bigint.js";
import { formatLegacyTornadoNote } from "../src/commands/export-tornado-note.js";
import { normalizeTornadoNoteInput } from "../src/commands/import-tornado-note.js";

describe("formatUsdCents", () => {
  it("rounds half-up to cents", () => {
    assert.equal(formatUsdCents(1_234_567n), "1.23");
    assert.equal(formatUsdCents(1_235_000n), "1.24");
    assert.equal(formatUsdCents(0n), "0.00");
    assert.equal(formatUsdCents(-12_345_000n), "-12.34");
  });
});

describe("jsonStringifyWithBigInt", () => {
  it("renders bigint values as decimal strings", () => {
    assert.equal(jsonStringifyWithBigInt({ a: 1n }), '{"a":"1"}');
    assert.equal(jsonStringifyWithBigInt([10n]), '["10"]');
  });
});

describe("normalizeTornadoNoteInput", () => {
  it("accepts classic notes and prefixes the short form", () => {
    const classic =
      "tornado-eth-1-1-0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123";
    assert.equal(normalizeTornadoNoteInput(` ${classic} `), classic);
    assert.equal(
      normalizeTornadoNoteInput("eth-1-1-0xab"),
      "tornado-eth-1-1-0xab"
    );
    assert.equal(normalizeTornadoNoteInput(""), "");
  });
});

describe("formatLegacyTornadoNote", () => {
  it("lowercases the currency and embeds chain id and 62-byte preimage", () => {
    const note = formatLegacyTornadoNote({
      currency: "ETH",
      denominationLabel: "1",
      chainId: 1n,
      nullifier: 1n,
      salt: 2n,
    });
    assert.ok(note.startsWith("tornado-eth-1-1-0x"));
    const hex = note.slice("tornado-eth-1-1-0x".length);
    assert.equal(hex.length, 124);
  });
});
