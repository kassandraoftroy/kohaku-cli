import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { it } from "node:test";

import { makeStorage, pluginStorePathForWallet } from "../src/host/storage.js";
import { loadStore, saveStore } from "../src/utils/aes-storage.js";

function temporaryStore() {
  const dir = mkdtempSync(join(tmpdir(), "kohaku-plugin-storage-"));
  return { dir, path: pluginStorePathForWallet(dir, "tc"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

it("round-trips both derivation states without combining their uncompressed strings", async () => {
  const fixture = temporaryStore();
  try {
    const state = JSON.stringify({ deposits: Array.from({ length: 20000 }, (_, i) => ({
      commitment: `0x${i.toString(16).padStart(64, "0")}`, blockNumber: "0x123456", pool: "0x1234",
    })) });
    const storage = makeStorage(fixture.dir, "tc", "pw");
    await storage.set("legacy-state", state);
    await storage.set("sig:state", state);
    const bytes = statSync(fixture.path).size;
    assert.ok(bytes < state.length / 5, `${bytes} persisted bytes for ${state.length * 2} state chars`);
    const persisted = JSON.parse(loadStore(fixture.path, "pw").store);
    assert.equal(persisted["legacy-state"].codec, "kohaku-gzip-v1");
    assert.equal(persisted["sig:state"].codec, "kohaku-gzip-v1");
    const reopened = makeStorage(fixture.dir, "tc", "pw");
    assert.equal(await reopened.get("legacy-state"), state);
    assert.equal(await reopened.get("sig:state"), state);
    assert.equal(await reopened.get("missing"), null);
    assert.doesNotMatch(readFileSync(fixture.path, "utf8"), /commitment|legacy-state|kohaku-gzip/);
  } finally { fixture.cleanup(); }
});

it("reads existing wallet entries and compresses them on the next normal save", async () => {
  const fixture = temporaryStore();
  try {
    const legacy = JSON.stringify({ deposits: "legacy mainnet history".repeat(10000) });
    saveStore(fixture.path, JSON.stringify({ existing: legacy, small: "hello 雪" }), "pw", { current: null });
    const before = readFileSync(fixture.path);
    const storage = makeStorage(fixture.dir, "tc", "pw");
    assert.equal(await storage.get("existing"), legacy);
    assert.equal(await storage.get("small"), "hello 雪");
    assert.deepEqual(readFileSync(fixture.path), before, "opening a wallet must not rewrite it");
    await storage.set("sig:new", legacy);
    const reopened = makeStorage(fixture.dir, "tc", "pw");
    assert.equal(await reopened.get("existing"), legacy);
    assert.equal(await reopened.get("sig:new"), legacy);
    assert.equal(await reopened.get("small"), "hello 雪");
    assert.throws(() => makeStorage(fixture.dir, "tc", "wrong"), /Failed to decrypt/);
  } finally { fixture.cleanup(); }
});

it("does not replace a stored value when saving to disk fails", async () => {
  const fixture = temporaryStore();
  try {
    const storage = makeStorage(fixture.dir, "tc", "pw");
    await storage.set("existing", "original");
    // Replacing the destination file with a directory makes writes fail.
    rmSync(fixture.path);
    mkdirSync(fixture.path);
    await assert.rejects(storage.set("existing", "replacement"));
    assert.equal(await storage.get("existing"), "original");
    await assert.rejects(storage.set("new", "replacement"));
    assert.equal(await storage.get("new"), null);
  } finally { fixture.cleanup(); }
});
