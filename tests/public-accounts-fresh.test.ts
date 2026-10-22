import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  adoptUsedPublicAccounts,
  selectNextUnusedPublicAccount,
  type PublicAccount,
} from "../src/utils/public-accounts.js";

function account(index: number): PublicAccount {
  return {
    address: `0x${index.toString(16).padStart(40, "0")}`,
    index,
    priv: `0x${"11".repeat(32)}`,
    tags: [],
    lastUpdated: 0,
    ethBalance: "0",
    erc20Balances: {},
    erc721Holdings: {},
  };
}

function cursor(accounts: PublicAccount[]) {
  let nextIndex = 0;
  const saved: PublicAccount[] = [];
  return {
    saved,
    peekNextAccounts(n: number) {
      return accounts.slice(nextIndex, nextIndex + n);
    },
    addNextAccounts(n: number) {
      const created = accounts.slice(nextIndex, nextIndex + n);
      nextIndex += n;
      saved.push(...created);
      return created;
    },
  };
}

describe("selectNextUnusedPublicAccount", () => {
  it("returns the peeked account when it is unused", async () => {
    const storage = cursor([account(0), account(1)]);
    const chosen = await selectNextUnusedPublicAccount(storage, async () => false);
    assert.equal(chosen.account.index, 0);
    assert.deepEqual(chosen.skipped, []);
    assert.deepEqual(storage.saved, []);
  });

  it("stores a used index and advances to the next unused account", async () => {
    const storage = cursor([account(0), account(1), account(2)]);
    const used = new Set([storage.peekNextAccounts(1)[0]!.address]);
    const chosen = await selectNextUnusedPublicAccount(storage, async (address) =>
      used.has(address)
    );
    assert.equal(chosen.account.index, 1);
    assert.deepEqual(
      chosen.skipped.map((row) => row.index),
      [0]
    );
    assert.deepEqual(
      storage.saved.map((row) => row.index),
      [0]
    );
  });

  it("stores every used index in a row", async () => {
    const storage = cursor([account(0), account(1), account(2)]);
    const chosen = await selectNextUnusedPublicAccount(
      storage,
      async (address) => address !== account(2).address
    );
    assert.equal(chosen.account.index, 2);
    assert.deepEqual(
      storage.saved.map((row) => row.index),
      [0, 1]
    );
  });
});

describe("adoptUsedPublicAccounts", () => {
  it("saves at most two used indexes ahead of the cursor", async () => {
    const storage = cursor([account(0), account(1), account(2)]);
    const adopted = await adoptUsedPublicAccounts(storage, async () => true, 2);
    assert.deepEqual(
      adopted.map((row) => row.index),
      [0, 1]
    );
    assert.deepEqual(
      storage.saved.map((row) => row.index),
      [0, 1]
    );
    assert.equal(storage.peekNextAccounts(1)[0]!.index, 2);
  });

  it("stops at the first unused index", async () => {
    const storage = cursor([account(0), account(1)]);
    const adopted = await adoptUsedPublicAccounts(
      storage,
      async (address) => address === account(1).address,
      2
    );
    assert.deepEqual(adopted, []);
    assert.deepEqual(storage.saved, []);
  });

  it("saves a used cursor account and leaves the following unused one", async () => {
    const storage = cursor([account(0), account(1)]);
    const adopted = await adoptUsedPublicAccounts(
      storage,
      async (address) => address === account(0).address,
      2
    );
    assert.deepEqual(
      adopted.map((row) => row.index),
      [0]
    );
    assert.equal(storage.peekNextAccounts(1)[0]!.index, 1);
  });
});
