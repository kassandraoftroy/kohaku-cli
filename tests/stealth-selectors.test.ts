import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseStealthStartBlock } from "../src/lib/stealth/scan.js";
import {
  formatStealthSelector,
  parseStealthIndex,
} from "../src/lib/stealth/storage.js";

describe("parseStealthIndex", () => {
  it("accepts sN and stealth:N case-insensitively", () => {
    assert.equal(parseStealthIndex("s0"), 0);
    assert.equal(parseStealthIndex("S1"), 1);
    assert.equal(parseStealthIndex(" stealth:12 "), 12);
    assert.equal(parseStealthIndex("STEALTH:3"), 3);
  });

  it("does not treat an HD index as a stealth selector", () => {
    assert.equal(parseStealthIndex("0"), null);
    assert.equal(parseStealthIndex("12"), null);
  });

  it("rejects malformed selectors", () => {
    assert.equal(parseStealthIndex("s-1"), null);
    assert.equal(parseStealthIndex("s0/1"), null);
    assert.equal(parseStealthIndex("s"), null);
    assert.equal(parseStealthIndex("stealth"), null);
  });
});

describe("formatStealthSelector", () => {
  it("round-trips through parseStealthIndex", () => {
    assert.equal(formatStealthSelector(0), "s0");
    assert.equal(parseStealthIndex(formatStealthSelector(7)), 7);
  });
});

describe("parseStealthStartBlock", () => {
  it("accepts decimal and 0x-hex block numbers", () => {
    assert.equal(parseStealthStartBlock("0"), 0n);
    assert.equal(parseStealthStartBlock("18000000"), 18000000n);
    assert.equal(parseStealthStartBlock(" 18000000 "), 18000000n);
    assert.equal(parseStealthStartBlock("0x10"), 16n);
  });

  it("rejects empty and garbage values", () => {
    assert.throws(
      () => parseStealthStartBlock(""),
      /non-empty block number/
    );
    assert.throws(
      () => parseStealthStartBlock("latest"),
      /decimal or 0x-hex/
    );
    assert.throws(
      () => parseStealthStartBlock("-1"),
      /decimal or 0x-hex/
    );
  });
});
