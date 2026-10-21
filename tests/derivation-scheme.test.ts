import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { tornadoNoteSecretSource } from "../src/commands/export-tornado-note.js";
import {
  chooseDerivationScheme,
  largerSchemeCap,
  prefixStorage,
  schemeCoverError,
  SIGNATURE_STORAGE_PREFIX,
} from "../src/utils/derivation-scheme.js";
import { tornadoSchemeCanCover } from "../src/utils/plugins.js";
import { privacyPoolsSchemeCovers } from "../src/utils/privacy-pools-paymaster.js";

const ETH = 10n ** 17n;

describe("chooseDerivationScheme", () => {
  it("prefers legacy when both schemes can cover", () => {
    assert.equal(
      chooseDerivationScheme({ legacyCanCover: true, signatureCanCover: true }),
      "legacy"
    );
  });

  it("falls back to signature when only signature can cover", () => {
    assert.equal(
      chooseDerivationScheme({ legacyCanCover: false, signatureCanCover: true }),
      "signature"
    );
  });

  it("returns null when neither scheme can cover", () => {
    assert.equal(
      chooseDerivationScheme({ legacyCanCover: false, signatureCanCover: false }),
      null
    );
    assert.match(
      schemeCoverError({ legacyLabel: "0.1 ETH", signatureLabel: "0.2 ETH" }),
      /Legacy spendable: 0.1 ETH. Signature spendable: 0.2 ETH/
    );
  });
});

describe("amount-max scheme cap", () => {
  it("picks the larger single-scheme cap and spends that scheme", () => {
    const legacyNotes = [ETH];
    const signatureNotes = [ETH, ETH, ETH];
    const legacyCap = ETH;
    const signatureCap = ETH * 3n;
    const amount = largerSchemeCap(legacyCap, signatureCap);
    assert.equal(amount, signatureCap);
    assert.equal(
      chooseDerivationScheme({
        legacyCanCover: tornadoSchemeCanCover(legacyNotes, amount),
        signatureCanCover: tornadoSchemeCanCover(signatureNotes, amount),
      }),
      "signature"
    );
  });

  it("spends legacy when the caps are equal", () => {
    const notes = [ETH];
    const amount = largerSchemeCap(ETH, ETH);
    assert.equal(
      chooseDerivationScheme({
        legacyCanCover: tornadoSchemeCanCover(notes, amount),
        signatureCanCover: tornadoSchemeCanCover(notes, amount),
      }),
      "legacy"
    );
  });

  it("does not treat the combined total as spendable", () => {
    const legacyNotes = [ETH];
    const signatureNotes = [ETH];
    const combined = ETH * 2n;
    assert.equal(tornadoSchemeCanCover(legacyNotes, combined), false);
    assert.equal(tornadoSchemeCanCover(signatureNotes, combined), false);
    assert.equal(
      chooseDerivationScheme({
        legacyCanCover: tornadoSchemeCanCover(legacyNotes, combined),
        signatureCanCover: tornadoSchemeCanCover(signatureNotes, combined),
      }),
      null
    );
  });
});

describe("prefixStorage", () => {
  it("reads and writes the same file under a prefix", async () => {
    const file = new Map<string, string>();
    const storage = {
      _brand: "Storage" as const,
      async get(key: string) {
        return file.get(key) ?? null;
      },
      async set(key: string, value: string) {
        file.set(key, value);
      },
    };
    const prefixed = prefixStorage(storage, SIGNATURE_STORAGE_PREFIX);
    await storage.set("tornado-cash-state-1-2", "legacy");
    await prefixed.set("tornado-cash-state-1-2", "signature");
    assert.equal(await storage.get("tornado-cash-state-1-2"), "legacy");
    assert.equal(
      await storage.get(`${SIGNATURE_STORAGE_PREFIX}tornado-cash-state-1-2`),
      "signature"
    );
    assert.equal(await prefixed.get("tornado-cash-state-1-2"), "signature");
  });
});

describe("tornadoNoteSecretSource", () => {
  it("selects signature, BIP-32, or imported secrets", () => {
    assert.equal(tornadoNoteSecretSource({ nonce: 4, depositIndex: -1 }), "signature");
    assert.equal(tornadoNoteSecretSource({ depositIndex: 0 }), "legacy-hd");
    assert.equal(tornadoNoteSecretSource({ depositIndex: -1 }), "imported");
    assert.equal(tornadoNoteSecretSource({}), "imported");
  });
});

describe("privacyPoolsSchemeCovers", () => {
  it("covers net plus that scheme's own fee and rejects a shortfall", async () => {
    const notes = [{ balance: 100n, approved: true, assetAddress: 1n }];
    assert.equal(
      await privacyPoolsSchemeCovers({
        notes,
        net: 80n,
        feeFor: async () => 10n,
      }),
      true
    );
    assert.equal(
      await privacyPoolsSchemeCovers({
        notes,
        net: 95n,
        feeFor: async () => 10n,
      }),
      false
    );
  });
});
