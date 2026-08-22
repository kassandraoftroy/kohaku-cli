import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress } from "viem";

import { parseTailCalls } from "../src/utils/unshield-tail-calls.js";

const TARGET = "0x9dAEf1EA5CC90C0F9DA9a5F0B49DA10510c34502";
const TARGET_LOWER = TARGET.toLowerCase();

describe("parseTailCalls", () => {
  it("parses TARGET:CALLDATA with a zero value", () => {
    assert.deepEqual(parseTailCalls(`${TARGET}:0x`), [
      { to: TARGET, data: "0x", value: 0n },
    ]);
  });

  it("checksums a lowercase target", () => {
    const [call] = parseTailCalls(`${TARGET_LOWER}:0xaabb`);
    assert.equal(call!.to, getAddress(TARGET_LOWER));
    assert.equal(call!.data, "0xaabb");
    assert.equal(call!.value, 0n);
  });

  it("parses decimal wei and 0x-hex values", () => {
    assert.equal(
      parseTailCalls(`${TARGET}:0x:1000`)[0]!.value,
      1000n
    );
    assert.equal(
      parseTailCalls(`${TARGET}:0x:0x64`)[0]!.value,
      100n
    );
  });

  it("parses comma-separated calls", () => {
    const calls = parseTailCalls(`${TARGET}:0x,${TARGET}:0xdead:1`);
    assert.equal(calls.length, 2);
    assert.equal(calls[1]!.data, "0xdead");
    assert.equal(calls[1]!.value, 1n);
  });

  it("rejects empty entries", () => {
    assert.throws(() => parseTailCalls(""), /comma-separated/);
    assert.throws(() => parseTailCalls(`${TARGET}:0x,`), /comma-separated/);
  });

  it("rejects a non-address target", () => {
    assert.throws(
      () => parseTailCalls("not-an-address:0x"),
      /Invalid tail call target at index 0/
    );
  });

  it("rejects odd-length or non-0x calldata", () => {
    assert.throws(
      () => parseTailCalls(`${TARGET}:0xabc`),
      /byte-aligned hex/
    );
    assert.throws(
      () => parseTailCalls(`${TARGET}:deadbeef`),
      /byte-aligned hex/
    );
  });

  it("rejects extra colons and missing slots", () => {
    assert.throws(
      () => parseTailCalls(`${TARGET}:0x:1:2`),
      /TARGET:CALLDATA or TARGET:CALLDATA:VALUE/
    );
    assert.throws(
      () => parseTailCalls(`${TARGET}:`),
      /TARGET:CALLDATA or TARGET:CALLDATA:VALUE/
    );
  });

  it("rejects a garbage value", () => {
    assert.throws(
      () => parseTailCalls(`${TARGET}:0x:-1`),
      /expected 0x-hex or decimal wei/
    );
    assert.throws(
      () => parseTailCalls(`${TARGET}:0x:1.5`),
      /expected 0x-hex or decimal wei/
    );
  });
});
