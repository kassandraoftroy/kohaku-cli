import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { getAddress, type Hex } from "viem";

import {
  hasCachedStealthProfile,
  makeStealthAccountsStorage,
} from "../src/lib/stealth/storage.js";

const ADDR = "0x9dAEf1EA5CC90C0F9DA9a5F0B49DA10510c34502";
const ADDR2 = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

function accountFields(address: string) {
  return {
    address,
    priv: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    ephemeralPublicKey:
      "0x02aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Hex,
    schemeId: 1,
    lastUpdated: 1,
    ethBalance: "0",
    erc20Balances: {},
  };
}

describe("makeStealthAccountsStorage", () => {
  it("merges a mixed-case re-upsert and does not bump nextStealthIndex", () => {
    const dir = mkdtempSync(join(tmpdir(), "kohaku-stealth-"));
    try {
      const storage = makeStealthAccountsStorage(dir, "pw");
      const first = storage.upsertAccount(accountFields(ADDR.toLowerCase()));
      assert.equal(first.stealthIndex, 0);
      assert.equal(first.address, getAddress(ADDR));
      assert.equal(storage.getStore().nextStealthIndex, 1);

      const merged = storage.upsertAccount({
        ...accountFields(ADDR),
        ethBalance: "42",
        name: "alice.gwei",
      });
      assert.equal(merged.stealthIndex, 0);
      assert.equal(merged.ethBalance, "42");
      assert.equal(merged.name, "alice.gwei");
      assert.equal(storage.getStore().nextStealthIndex, 1);
      assert.equal(storage.getAccounts().length, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("finds accounts by address case-insensitively", () => {
    const dir = mkdtempSync(join(tmpdir(), "kohaku-stealth-"));
    try {
      const storage = makeStealthAccountsStorage(dir, "pw");
      storage.upsertAccount(accountFields(ADDR));
      assert.equal(
        storage.findByAddress(ADDR.toLowerCase())?.address,
        getAddress(ADDR)
      );
      assert.equal(storage.findByAddress(ADDR2), undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("treats a missing or cleared profile as not cached", () => {
    const dir = mkdtempSync(join(tmpdir(), "kohaku-stealth-"));
    try {
      const storage = makeStealthAccountsStorage(dir, "pw");
      assert.equal(hasCachedStealthProfile(storage.getStore()), false);

      storage.setProfile({
        name: "alice.gwei",
        index: 0,
        address: ADDR,
        stealthMetaAddressURI: "st:eth:0x01",
      });
      assert.equal(hasCachedStealthProfile(storage.getStore()), true);
      assert.equal(storage.getStore().name, "alice.gwei");

      storage.clearProfile();
      assert.equal(storage.getStore().profile, null);
      assert.equal(storage.getStore().name, undefined);
      assert.equal(hasCachedStealthProfile(storage.getStore()), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
