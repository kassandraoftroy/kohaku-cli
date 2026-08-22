import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  decrypt,
  deriveKeyFromPassword,
  encrypt,
  generateSalt,
  isEncryptedEnvelopeV1,
  loadStore,
  saveStore,
} from "../src/utils/aes-storage.js";

describe("isEncryptedEnvelopeV1", () => {
  it("accepts a well-formed envelope and rejects plaintext JSON", () => {
    assert.equal(
      isEncryptedEnvelopeV1({
        v: 1,
        salt: "a",
        iv: "b",
        tag: "c",
        ciphertext: "d",
      }),
      true
    );
    assert.equal(isEncryptedEnvelopeV1({ foo: "bar" }), false);
    assert.equal(isEncryptedEnvelopeV1(null), false);
    assert.equal(isEncryptedEnvelopeV1("secret"), false);
  });
});

describe("deriveKeyFromPassword", () => {
  it("rejects an empty password", () => {
    assert.throws(
      () => deriveKeyFromPassword("", generateSalt()),
      /Password cannot be empty/
    );
  });
});

describe("encrypt/decrypt", () => {
  it("round-trips UTF-8 plaintext", () => {
    const salt = generateSalt();
    const envelope = encrypt("hello stealth", "pw", salt);
    assert.equal(isEncryptedEnvelopeV1(envelope), true);
    assert.equal(decrypt(envelope, "pw"), "hello stealth");
  });

  it("fails closed on the wrong password", () => {
    const envelope = encrypt("secret", "right", generateSalt());
    assert.throws(() => decrypt(envelope, "wrong"));
  });
});

describe("loadStore / saveStore", () => {
  it("returns an empty store when the file is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "kohaku-aes-"));
    try {
      const missing = join(dir, "nope.json");
      assert.deepEqual(loadStore(missing, "pw"), {
        store: JSON.stringify({}),
        salt: null,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws on a non-envelope file instead of returning it as plaintext", () => {
    const dir = mkdtempSync(join(tmpdir(), "kohaku-aes-"));
    try {
      const path = join(dir, "store.json");
      writeFileSync(path, JSON.stringify({ accounts: [] }));
      assert.throws(() => loadStore(path, "pw"), /Invalid storage file/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("round-trips through saveStore", () => {
    const dir = mkdtempSync(join(tmpdir(), "kohaku-aes-"));
    try {
      const path = join(dir, "store.json");
      const saltRef = { current: null as Uint8Array | null };
      saveStore(path, JSON.stringify({ ok: 1 }), "pw", saltRef);
      const loaded = loadStore(path, "pw");
      assert.equal(loaded.store, JSON.stringify({ ok: 1 }));
      assert.ok(loaded.salt);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
