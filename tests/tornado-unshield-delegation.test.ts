import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { makeKeystore } from "../src/host/keystore.js";
import { makePublicAccountsStorage, type PublicAccount } from "../src/utils/public-accounts.js";

import { stealthDelegatorPath } from "../src/lib/stealth/constants.js";
import {
  TORNADO_MULTI_NOTE_REQUIRE_WALLET_CONTROLLED,
  TORNADO_TAILS_REQUIRE_WALLET_CONTROLLED,
  assertTornadoTailCallsHaveHdDelegator,
  tornadoDelegationConfig,
  reserveTornadoUnshieldExecutor,
  tornadoUnshieldConfirmExtraLines,
} from "../src/utils/tornado-unshield-delegation.js";

const HD_PATH = "m/44'/60'/0'/0/3";
const STEALTH_PATH = stealthDelegatorPath(0);
const RECIPIENT = "0x9dAEf1EA5CC90C0F9DA9a5F0B49DA10510c34502" as const;

describe("tornadoDelegationConfig", () => {
  for (const path of [HD_PATH, STEALTH_PATH]) {
    it(`uses the stored recipient for a single note without tails (${path})`, () => {
      assert.deepEqual(tornadoDelegationConfig({ delegationPath: path, tailCallsCount: 0, withdrawalCount: 1 }),
        { mode: "deterministic", path });
    });
  }

  it("uses wallet-path deterministic for stored HD + tails", () => {
    assert.deepEqual(
      tornadoDelegationConfig({
        delegationPath: HD_PATH,
        tailCallsCount: 1,
        withdrawalCount: 1,
      }),
      { mode: "deterministic", path: HD_PATH }
    );
  });

  it("uses wallet-path deterministic for stored stealth + tails", () => {
    assert.deepEqual(
      tornadoDelegationConfig({
        delegationPath: STEALTH_PATH,
        tailCallsCount: 1,
        withdrawalCount: 1,
      }),
      { mode: "deterministic", path: STEALTH_PATH }
    );
  });

  it("uses wallet-path deterministic for stored HD + multi-note", () => {
    assert.deepEqual(
      tornadoDelegationConfig({
        delegationPath: HD_PATH,
        tailCallsCount: 0,
        withdrawalCount: 3,
      }),
      { mode: "deterministic", path: HD_PATH }
    );
  });

  it("uses wallet-path deterministic for stored stealth + multi-note", () => {
    assert.deepEqual(
      tornadoDelegationConfig({
        delegationPath: STEALTH_PATH,
        tailCallsCount: 0,
        withdrawalCount: 2,
      }),
      { mode: "deterministic", path: STEALTH_PATH }
    );
  });

  it("uses the SDK default sender for custom --to single-note with no tails", () => {
    assert.deepEqual(
      tornadoDelegationConfig({
        delegationPath: undefined,
        tailCallsCount: 0,
        withdrawalCount: 1,
      }),
      undefined
    );
  });

  it("treats blank path as missing", () => {
    assert.deepEqual(
      tornadoDelegationConfig({
        delegationPath: "  ",
        tailCallsCount: 0,
        withdrawalCount: 1,
      }),
      undefined
    );
  });

  it("throws when --tail-calls target an unstored --to", () => {
    assert.throws(
      () =>
        tornadoDelegationConfig({
          delegationPath: undefined,
          tailCallsCount: 1,
          withdrawalCount: 1,
        }),
      (err: Error) => {
        assert.equal(err.message, TORNADO_TAILS_REQUIRE_WALLET_CONTROLLED);
        return true;
      }
    );
  });

  it("throws when multi-note would consolidate onto a mystery 7702", () => {
    assert.throws(
      () =>
        tornadoDelegationConfig({
          delegationPath: undefined,
          tailCallsCount: 0,
          withdrawalCount: 2,
        }),
      (err: Error) => {
        assert.equal(err.message, TORNADO_MULTI_NOTE_REQUIRE_WALLET_CONTROLLED);
        return true;
      }
    );
  });

  it("rejects a zero withdrawal count", () => {
    assert.throws(
      () =>
        tornadoDelegationConfig({
          delegationPath: HD_PATH,
          tailCallsCount: 0,
          withdrawalCount: 0,
        }),
      /at least one withdrawal/
    );
  });
});

describe("assertTornadoTailCallsHaveHdDelegator", () => {
  it("allows tails with a stored HD path", () => {
    assertTornadoTailCallsHaveHdDelegator(HD_PATH, 2);
  });

  it("allows tails with a stored stealth magic path", () => {
    assertTornadoTailCallsHaveHdDelegator(STEALTH_PATH, 1);
  });

  it("allows no tails without a path", () => {
    assertTornadoTailCallsHaveHdDelegator(undefined, 0);
  });

  it("rejects tails without a stored wallet-controlled path", () => {
    assert.throws(
      () => assertTornadoTailCallsHaveHdDelegator(undefined, 1),
      (err: Error) => {
        assert.equal(err.message, TORNADO_TAILS_REQUIRE_WALLET_CONTROLLED);
        return true;
      }
    );
  });
});

describe("tornadoUnshieldConfirmExtraLines", () => {
  it("names the wallet 7702 executor when HD tails consolidate", () => {
    assert.deepEqual(
      tornadoUnshieldConfirmExtraLines({
        recipient: RECIPIENT,
        delegationPath: HD_PATH,
        hasTailCalls: true,
        withdrawalCount: 1,
      }),
      [
        `  EIP-7702 executor: ${RECIPIENT} (this wallet)`,
        "  Tail-calls execute on the EIP-7702 executor",
        "  Unused-gas refunds stay on this executor",
      ]
    );
  });

  it("names the stealth 7702 executor when stealth tails consolidate", () => {
    assert.deepEqual(
      tornadoUnshieldConfirmExtraLines({
        recipient: RECIPIENT,
        delegationPath: STEALTH_PATH,
        hasTailCalls: true,
        withdrawalCount: 1,
      }),
      [
        `  EIP-7702 executor: ${RECIPIENT} (this wallet, stealth s0)`,
        "  Tail-calls execute on the EIP-7702 executor",
        "  Unused-gas refunds stay on this executor",
      ]
    );
  });

  it("shows the note-derived sender as temporary and the direct payout for custom --to", () => {
    assert.deepEqual(
      tornadoUnshieldConfirmExtraLines({
        recipient: RECIPIENT,
        sender: "0x0000000000000000000000000000000000000001",
        hasTailCalls: false,
        withdrawalCount: 1,
      }),
      [
        "  EIP-7702 executor: 0x0000000000000000000000000000000000000001 (temporary)",
        "  The withdrawal and unused-gas refund go directly to the recipient",
      ]
    );
  });

  it("shows the wallet executor even for a single note without user tails", () => {
    assert.deepEqual(
      tornadoUnshieldConfirmExtraLines({
        recipient: RECIPIENT,
        delegationPath: HD_PATH,
        hasTailCalls: false,
        withdrawalCount: 1,
      }),
      [`  EIP-7702 executor: ${RECIPIENT} (this wallet)`, "  Unused-gas refunds stay on this executor"]
    );
  });
});

describe("reserveTornadoUnshieldExecutor", () => {
  function account(index: number): PublicAccount {
    return { address: "0x" + (index + 1).toString(16).padStart(40, "0"), index,
      priv: "0x" + "11".repeat(32), tags: [], lastUpdated: 0, ethBalance: "0",
      erc20Balances: {}, erc721Holdings: {} };
  }
  function cursor() {
    let next = 0;
    const saved: PublicAccount[] = [];
    return {
      saved,
      peekNextAccounts: (n: number) => Array.from({ length: n }, (_, i) => account(next + i)),
      addNextAccounts: (n: number) => {
        const created = Array.from({ length: n }, (_, i) => account(next + i));
        next += n;
        saved.push(...created);
        return created;
      },
    };
  }

  it("saves skipped used accounts and reserves the fresh executor before prepare", async () => {
    const storage = cursor();
    const selected = await reserveTornadoUnshieldExecutor(storage, async address => address === account(0).address);
    assert.deepEqual(selected, {
      executor: { address: account(1).address, index: 1, delegationPath: "m/44'/60'/0'/0/1" },
      skipped: [{ address: account(0).address, index: 0 }],
    });
    assert.deepEqual(storage.saved.map(a => a.index), [0, 1]);
    assert.equal(JSON.stringify(selected).includes(account(1).priv), false);
    const following = await reserveTornadoUnshieldExecutor(storage, async () => false);
    assert.equal(following.executor.index, 2);
  });

  it("keeps the reserved account after failed preparation and never reuses its index", async () => {
    const storage = cursor();
    await assert.rejects(async () => {
      await reserveTornadoUnshieldExecutor(storage, async () => false);
      throw new Error("Preparation failed after signing");
    }, /Preparation failed/);
    assert.deepEqual(storage.saved.map(a => a.index), [0]);
    assert.equal((await reserveTornadoUnshieldExecutor(storage, async () => false)).executor.index, 1);
  });

  it("does not reserve an executor when freshness cannot be checked", async () => {
    const storage = cursor();
    await assert.rejects(reserveTornadoUnshieldExecutor(storage, async () => { throw new Error("RPC unavailable"); }), /RPC unavailable/);
    assert.deepEqual(storage.saved, []);
  });

  it("rejects a different persisted account before preparing signatures", async () => {
    await assert.rejects(reserveTornadoUnshieldExecutor({
      peekNextAccounts: () => [account(0)],
      addNextAccounts: () => [account(1)],
    }, async () => false), /changed before reservation/);
  });

  it("persists in normal wallet storage and the SDK keystore path derives the same key", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tornado-executor-"));
    const mnemonic = "test test test test test test test test test test test junk";
    const password = "synthetic-test-password";
    try {
      const selected = await reserveTornadoUnshieldExecutor(
        makePublicAccountsStorage(dir, mnemonic, password), async () => false);
      const key = await makeKeystore(mnemonic).deriveAt(selected.executor.delegationPath);
      assert.equal(privateKeyToAccount(key).address, selected.executor.address);
      // This is the same persisted account list read by balances, reopened from disk.
      const reopened = makePublicAccountsStorage(dir, mnemonic, password);
      assert.equal(reopened.getAccounts()[0].address, selected.executor.address);
      assert.equal(reopened.getAccount(selected.executor.index)?.priv, key);
      assert.equal(reopened.peekNextAccounts(1)[0].index, selected.executor.index + 1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

it("shows the public account index and refund destination separately from a custom payout", () => {
  const sender = "0x0000000000000000000000000000000000000001";
  assert.deepEqual(tornadoUnshieldConfirmExtraLines({
    recipient: RECIPIENT, sender, delegationPath: HD_PATH, executorAccountIndex: 3,
    refundRecipient: sender, hasTailCalls: false, withdrawalCount: 2,
  }), [
    "  EIP-7702 executor: " + sender + " (this wallet, public account [3])",
    "  The executor forwards the withdrawal minus its fee to the recipient",
    "  Unused-gas refunds stay on this executor",
  ]);
  assert.deepEqual(tornadoUnshieldConfirmExtraLines({
    recipient: RECIPIENT, sender, delegationPath: HD_PATH, executorAccountIndex: 3,
    refundRecipient: RECIPIENT, hasTailCalls: false, withdrawalCount: 1,
  }), [
    "  EIP-7702 executor: " + sender + " (this wallet, public account [3])",
    "  The withdrawal pays the recipient directly",
    "  Unused-gas refunds go to " + RECIPIENT,
  ]);
});
