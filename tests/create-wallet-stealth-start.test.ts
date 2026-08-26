import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { interpretImportStealthStartBlockFlag } from "../src/lib/create-wallet.js";
import {
  defaultStealthImportStartBlock,
  stealthAnnouncerStartBlock,
} from "../src/lib/stealth/constants.js";

const MAINNET = 1n;
const SEPOLIA = 11155111n;

describe("interpretImportStealthStartBlockFlag", () => {
  it("omitted flag means the caller should write the chain tip", () => {
    assert.equal(
      interpretImportStealthStartBlockFlag(undefined, MAINNET),
      undefined
    );
    assert.equal(
      interpretImportStealthStartBlockFlag(undefined, SEPOLIA),
      undefined
    );
  });

  it("bare flag uses the Kohaku-schema floor for the chain", () => {
    assert.equal(
      interpretImportStealthStartBlockFlag(true, MAINNET),
      defaultStealthImportStartBlock(MAINNET)
    );
    assert.equal(
      interpretImportStealthStartBlockFlag(true, SEPOLIA),
      defaultStealthImportStartBlock(SEPOLIA)
    );
    assert.equal(
      interpretImportStealthStartBlockFlag("", MAINNET),
      defaultStealthImportStartBlock(MAINNET)
    );
  });

  it("parses an explicit decimal or 0x-hex block at or above deploy", () => {
    assert.equal(
      interpretImportStealthStartBlockFlag("30000000", MAINNET),
      30_000_000n
    );
    assert.equal(
      interpretImportStealthStartBlockFlag("0x1000000", SEPOLIA),
      0x1000000n
    );
  });

  it("rounds an explicit block up to the announcer deploy floor", () => {
    const mainnetDeploy = stealthAnnouncerStartBlock(MAINNET);
    const sepoliaDeploy = stealthAnnouncerStartBlock(SEPOLIA);
    assert.equal(
      interpretImportStealthStartBlockFlag("0", MAINNET),
      mainnetDeploy
    );
    assert.equal(
      interpretImportStealthStartBlockFlag("10000000", MAINNET),
      mainnetDeploy
    );
    assert.equal(
      interpretImportStealthStartBlockFlag("0x1", SEPOLIA),
      sepoliaDeploy
    );
  });

  it("rejects garbage explicit values", () => {
    assert.throws(
      () => interpretImportStealthStartBlockFlag("latest", MAINNET),
      /decimal or 0x-hex/
    );
  });
});
