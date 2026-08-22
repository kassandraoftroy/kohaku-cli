import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { stealthDelegatorPath } from "../src/lib/stealth/constants.js";
import {
  TORNADO_MULTI_NOTE_REQUIRE_WALLET_CONTROLLED,
  TORNADO_TAILS_REQUIRE_WALLET_CONTROLLED,
  assertTornadoTailCallsHaveHdDelegator,
  tornadoDelegationConfig,
  tornadoUnshieldConfirmExtraLines,
} from "../src/utils/tornado-unshield-delegation.js";

const HD_PATH = "m/44'/60'/0'/0/3";
const STEALTH_PATH = stealthDelegatorPath(0);
const RECIPIENT = "0x9dAEf1EA5CC90C0F9DA9a5F0B49DA10510c34502" as const;

describe("tornadoDelegationConfig", () => {
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

  it("omits delegation for custom --to single-note with no tails", () => {
    assert.equal(
      tornadoDelegationConfig({
        delegationPath: undefined,
        tailCallsCount: 0,
        withdrawalCount: 1,
      }),
      undefined
    );
  });

  it("treats blank path as missing", () => {
    assert.equal(
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
      ]
    );
  });

  it("says direct withdrawal for custom --to", () => {
    assert.deepEqual(
      tornadoUnshieldConfirmExtraLines({
        recipient: RECIPIENT,
        hasTailCalls: false,
        withdrawalCount: 1,
      }),
      [
        "  Direct Tornado withdrawal to this address (single note; no wallet 7702 landing account)",
      ]
    );
  });

  it("adds no extra lines for stored HD single-note with no tails", () => {
    assert.deepEqual(
      tornadoUnshieldConfirmExtraLines({
        recipient: RECIPIENT,
        delegationPath: HD_PATH,
        hasTailCalls: false,
        withdrawalCount: 1,
      }),
      []
    );
  });
});
