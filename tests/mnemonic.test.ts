import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  SEED_FILENAME,
  isSeedKeystoreV1,
  normalizeValidatedMnemonic,
  peekAddressesFromMnemonic,
  readSeedKeystore,
  writeSeedKeystore,
} from "../src/utils/mnemonic.js";

const MNEMONIC =
  "test test test test test test test test test test test junk";

describe("normalizeValidatedMnemonic", () => {
  it("trims a valid BIP-39 phrase", () => {
    assert.equal(normalizeValidatedMnemonic(`  ${MNEMONIC}  `), MNEMONIC);
  });

  it("rejects empty and invalid phrases", () => {
    assert.throws(() => normalizeValidatedMnemonic(""), /cannot be empty/);
    assert.throws(
      () => normalizeValidatedMnemonic("not a mnemonic"),
      /Invalid BIP-39 mnemonic phrase/
    );
  });
});

describe("isSeedKeystoreV1", () => {
  it("requires kind, version, and an AES envelope", () => {
    assert.equal(
      isSeedKeystoreV1({
        kind: "kohaku-cli/seed",
        version: 1,
        crypto: { v: 1, salt: "a", iv: "b", tag: "c", ciphertext: "d" },
      }),
      true
    );
    assert.equal(
      isSeedKeystoreV1({
        v: 1,
        salt: "a",
        iv: "b",
        tag: "c",
        ciphertext: "d",
      }),
      false
    );
  });
});

describe("writeSeedKeystore / readSeedKeystore", () => {
  it("round-trips a mnemonic and refuses to overwrite", () => {
    const dir = mkdtempSync(join(tmpdir(), "kohaku-seed-"));
    try {
      writeSeedKeystore(MNEMONIC, "pw", dir);
      assert.equal(readSeedKeystore("pw", dir), MNEMONIC);
      assert.throws(
        () => writeSeedKeystore(MNEMONIC, "pw", dir),
        /already exists. Never overwrite existing seed/
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails closed on the wrong password", () => {
    const dir = mkdtempSync(join(tmpdir(), "kohaku-seed-"));
    try {
      writeSeedKeystore(MNEMONIC, "right", dir);
      assert.throws(
        () => readSeedKeystore("wrong", dir),
        /wrong password or corrupted file/
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws when the seed file is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "kohaku-seed-"));
    try {
      assert.throws(
        () => readSeedKeystore("pw", dir),
        /Seed keystore not found/
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a JSON file that is not a seed keystore", () => {
    const dir = mkdtempSync(join(tmpdir(), "kohaku-seed-"));
    try {
      writeFileSync(join(dir, SEED_FILENAME), JSON.stringify({ v: 1 }));
      assert.throws(
        () => readSeedKeystore("pw", dir),
        /Invalid or unsupported seed keystore/
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("peekAddressesFromMnemonic", () => {
  it("derives the well-known junk-mnemonic account 0", () => {
    assert.deepEqual(peekAddressesFromMnemonic(MNEMONIC, [0]), [
      "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
    ]);
  });
});
