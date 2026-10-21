import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { stealthDelegatorPath } from "../src/lib/stealth/constants.js";
import {
  PRIVACY_POOLS_MULTI_NOTE_REQUIRE_WALLET_CONTROLLED,
  PRIVACY_POOLS_TAILS_REQUIRE_WALLET_CONTROLLED,
  assertPrivacyPoolsTailCallsHaveHdDelegator,
  assertPrivacyPoolsWalletDelegator,
  privacyPoolsDelegationConfig,
  privacyPoolsUnshieldConfirmExtraLines,
} from "../src/utils/privacy-pools-unshield-delegation.js";

const HD_PATH = "m/44'/60'/0'/0/3";
const STEALTH_PATH = stealthDelegatorPath(0);
const RECIPIENT = "0x9dAEf1EA5CC90C0F9DA9a5F0B49DA10510c34502" as const;

describe("assertPrivacyPoolsWalletDelegator", () => {
  it("allows stored HD and stealth paths for tails and multi-note", () => {
    assertPrivacyPoolsWalletDelegator({
      delegationPath: HD_PATH,
      tailCallsCount: 1,
      withdrawalCount: 1,
    });
    assertPrivacyPoolsWalletDelegator({
      delegationPath: STEALTH_PATH,
      tailCallsCount: 0,
      withdrawalCount: 3,
    });
  });

  it("allows a custom --to for a single note with no tails", () => {
    assertPrivacyPoolsWalletDelegator({
      delegationPath: undefined,
      tailCallsCount: 0,
      withdrawalCount: 1,
    });
    assertPrivacyPoolsWalletDelegator({
      delegationPath: "  ",
      tailCallsCount: 0,
      withdrawalCount: 1,
    });
  });

  it("rejects tails without a stored wallet path", () => {
    assert.throws(
      () =>
        assertPrivacyPoolsWalletDelegator({
          delegationPath: undefined,
          tailCallsCount: 1,
          withdrawalCount: 1,
        }),
      (err: Error) => {
        assert.equal(err.message, PRIVACY_POOLS_TAILS_REQUIRE_WALLET_CONTROLLED);
        return true;
      }
    );
  });

  it("rejects multi-note without a stored wallet path", () => {
    assert.throws(
      () =>
        assertPrivacyPoolsWalletDelegator({
          delegationPath: undefined,
          tailCallsCount: 0,
          withdrawalCount: 2,
        }),
      (err: Error) => {
        assert.equal(err.message, PRIVACY_POOLS_MULTI_NOTE_REQUIRE_WALLET_CONTROLLED);
        return true;
      }
    );
  });

  it("rejects a zero withdrawal count", () => {
    assert.throws(
      () =>
        assertPrivacyPoolsWalletDelegator({
          delegationPath: HD_PATH,
          tailCallsCount: 0,
          withdrawalCount: 0,
        }),
      /at least one withdrawal/
    );
  });
});

describe("assertPrivacyPoolsTailCallsHaveHdDelegator", () => {
  it("allows no tails without a path", () => {
    assertPrivacyPoolsTailCallsHaveHdDelegator(undefined, 0);
  });

  it("rejects tails without a stored wallet-controlled path", () => {
    assert.throws(
      () => assertPrivacyPoolsTailCallsHaveHdDelegator(undefined, 1),
      (err: Error) => {
        assert.equal(err.message, PRIVACY_POOLS_TAILS_REQUIRE_WALLET_CONTROLLED);
        return true;
      }
    );
  });
});

describe("privacyPoolsDelegationConfig", () => {
  it("passes a stored HD path", () => {
    assert.deepEqual(
      privacyPoolsDelegationConfig({
        delegationPath: HD_PATH,
        tailCallsCount: 1,
        withdrawalCount: 2,
      }),
      { mode: "deterministic", path: HD_PATH }
    );
  });

  it("passes the stealth sentinel path", () => {
    assert.deepEqual(
      privacyPoolsDelegationConfig({
        delegationPath: STEALTH_PATH,
        tailCallsCount: 0,
        withdrawalCount: 1,
      }),
      { mode: "deterministic", path: STEALTH_PATH }
    );
  });

  it("omits delegation for a custom --to single note", () => {
    assert.equal(
      privacyPoolsDelegationConfig({
        delegationPath: undefined,
        tailCallsCount: 0,
        withdrawalCount: 1,
      }),
      undefined
    );
  });
});

describe("privacyPoolsUnshieldConfirmExtraLines", () => {
  it("names the wallet 7702 executor when the sender is --to", () => {
    assert.deepEqual(
      privacyPoolsUnshieldConfirmExtraLines({
        recipient: RECIPIENT,
        delegationPath: HD_PATH,
        hasTailCalls: true,
        sender: RECIPIENT,
      }),
      [
        `  EIP-7702 executor: ${RECIPIENT} (this wallet)`,
        "  Tail-calls execute on the EIP-7702 executor; leftover funds stay on that account",
      ]
    );
  });

  it("names the stealth 7702 executor when stealth tails consolidate", () => {
    assert.deepEqual(
      privacyPoolsUnshieldConfirmExtraLines({
        recipient: RECIPIENT,
        delegationPath: STEALTH_PATH,
        hasTailCalls: false,
        sender: RECIPIENT,
      }),
      [
        `  EIP-7702 executor: ${RECIPIENT} (this wallet, stealth s0)`,
        "  Withdrawn funds land on the EIP-7702 executor",
      ]
    );
  });

  it("says direct withdrawal for custom --to", () => {
    assert.deepEqual(
      privacyPoolsUnshieldConfirmExtraLines({
        recipient: RECIPIENT,
        hasTailCalls: false,
      }),
      [
        "  Direct Privacy Pools withdrawal to this address (single note; no wallet 7702 landing account)",
      ]
    );
  });

  it("adds no extra lines for stored HD single-note with no tails", () => {
    assert.deepEqual(
      privacyPoolsUnshieldConfirmExtraLines({
        recipient: RECIPIENT,
        delegationPath: HD_PATH,
        hasTailCalls: false,
      }),
      []
    );
  });
});
