import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  isFirstProtocolSync,
  noteProtocolStorageFreshness,
  resetFirstSyncObservations,
} from "../src/utils/first-sync.js";

const dirs: string[] = [];

function walletDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "kohaku-first-sync-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  resetFirstSyncObservations();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("isFirstProtocolSync", () => {
  it("is true when the protocol has no storage file", () => {
    const dir = walletDir();
    assert.equal(isFirstProtocolSync(dir, "railgun"), true);
    assert.equal(isFirstProtocolSync(dir, "tornado"), true);
    assert.equal(isFirstProtocolSync(dir, "privacy-pools"), true);
  });

  it("is false once the protocol has storage", () => {
    const dir = walletDir();
    writeFileSync(join(dir, "rg-storage.json"), "{}");
    assert.equal(isFirstProtocolSync(dir, "railgun"), false);
    // Storage is per protocol, so the others are untouched.
    assert.equal(isFirstProtocolSync(dir, "tornado"), true);
  });

  it("stays true when storage was seeded after the Host was built", () => {
    const dir = walletDir();
    // Privacy Pools writes a bundled snapshot while the plugin is constructed,
    // i.e. before any sync runs.
    noteProtocolStorageFreshness(dir, "ppv1");
    writeFileSync(join(dir, "ppv1-storage.json"), "{}");
    assert.equal(isFirstProtocolSync(dir, "privacy-pools"), true);
  });

  it("keeps the first observation for a wallet", () => {
    const dir = walletDir();
    writeFileSync(join(dir, "tc-storage.json"), "{}");
    noteProtocolStorageFreshness(dir, "tc");
    noteProtocolStorageFreshness(dir, "tc");
    assert.equal(isFirstProtocolSync(dir, "tornado"), false);
  });

  it("tracks wallets independently", () => {
    const withState = walletDir();
    const fresh = walletDir();
    writeFileSync(join(withState, "rg-storage.json"), "{}");
    noteProtocolStorageFreshness(withState, "rg");
    noteProtocolStorageFreshness(fresh, "rg");
    assert.equal(isFirstProtocolSync(withState, "railgun"), false);
    assert.equal(isFirstProtocolSync(fresh, "railgun"), true);
  });
});
