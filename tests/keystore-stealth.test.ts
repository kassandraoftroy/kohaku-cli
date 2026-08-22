import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { makeKeystore } from "../src/host/keystore.js";
import { stealthDelegatorPath } from "../src/lib/stealth/constants.js";
import { publicAccountDerivationPath } from "../src/utils/public-accounts.js";

const MNEMONIC =
  "test test test test test test test test test test test junk";
const STEALTH_PRIV =
  "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

describe("makeKeystore stealth magic path", () => {
  it("returns the stored stealth key for STEALTH_ADDRESS_MAGIC_VALUE_PATH", async () => {
    const ks = makeKeystore(MNEMONIC, {
      stealthDelegatorPriv: (idx) => (idx === 0 ? STEALTH_PRIV : null),
    });
    assert.equal(await ks.deriveAt(stealthDelegatorPath(0)), STEALTH_PRIV);
  });

  it("does not fall through to HD when the stealth account is missing", async () => {
    const ks = makeKeystore(MNEMONIC, {
      stealthDelegatorPriv: () => null,
    });
    await assert.rejects(
      ks.deriveAt(stealthDelegatorPath(0)),
      /Stealth account s0 not found/
    );
  });

  it("still HD-derives public account paths", async () => {
    const withLookup = makeKeystore(MNEMONIC, {
      stealthDelegatorPriv: () => STEALTH_PRIV,
    });
    const plain = makeKeystore(MNEMONIC);
    const path = publicAccountDerivationPath(0);
    assert.equal(await withLookup.deriveAt(path), await plain.deriveAt(path));
    assert.notEqual(await withLookup.deriveAt(path), STEALTH_PRIV);
  });
});
