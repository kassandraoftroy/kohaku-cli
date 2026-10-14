import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  PP_PAYMASTER_GAS,
  assertPrivacyPoolsMinimumDeposit,
  assertPrivacyPoolsPaymasterConfigured,
  countPrivacyPoolsNotesForAmount,
  privacyPoolsAdapterForPool,
  privacyPoolsApprovedNotes,
  privacyPoolsFeeWei,
  privacyPoolsPayoutTailCalls,
  privacyPoolsRequiredGas,
  privacyPoolsVettingFee,
  type PpNoteBalance,
} from "../src/utils/privacy-pools-paymaster.js";
import { encodeTornadoErc20TransferTailCall } from "../src/utils/tornado-tail-gas.js";

const ETH_POOL = "0xf241d57c6debae225c0f2e6ea1529373c9a9c9fb";
const RECIPIENT = "0x1111111111111111111111111111111111111111" as const;
const TOKEN = "0x2222222222222222222222222222222222222222" as const;

function note(
  balance: bigint,
  assetAddress: string,
  approved = true
): PpNoteBalance {
  return { balance, approved, assetAddress };
}

describe("privacyPoolsApprovedNotes", () => {
  const asset = ETH_POOL;
  const notes = [
    note(10n, asset),
    note(50n, asset),
    note(30n, asset, false),
    note(0n, asset),
    note(40n, "0x3333333333333333333333333333333333333333"),
    note(20n, asset),
  ];

  it("keeps approved notes for the asset, largest first", () => {
    assert.deepEqual(
      privacyPoolsApprovedNotes(notes, asset).map((n) => n.balance),
      [50n, 20n, 10n]
    );
  });
});

describe("countPrivacyPoolsNotesForAmount", () => {
  const notes = [note(100n, ETH_POOL), note(40n, ETH_POOL), note(10n, ETH_POOL)];

  it("spends the largest note first and a partial last note", () => {
    assert.equal(countPrivacyPoolsNotesForAmount(notes, 100n), 1);
    assert.equal(countPrivacyPoolsNotesForAmount(notes, 120n), 2);
    assert.equal(countPrivacyPoolsNotesForAmount(notes, 150n), 3);
  });

  it("throws when approved notes cannot cover the gross", () => {
    assert.throws(
      () => countPrivacyPoolsNotesForAmount(notes, 151n),
      /Insufficient Privacy Pools balance/
    );
  });
});

describe("privacyPools paymaster fee", () => {
  const price = 2n;

  it("prices a single note with no execution-phase gas", () => {
    const gas = privacyPoolsRequiredGas({
      isErc20: false,
      extraWithdrawals: 0,
      hasUserTailCalls: false,
    });
    assert.equal(
      gas,
      PP_PAYMASTER_GAS.verificationGasLimit +
        PP_PAYMASTER_GAS.paymasterVerificationGasLimit +
        PP_PAYMASTER_GAS.preVerificationGas +
        PP_PAYMASTER_GAS.paymasterPostOpGasLimit
    );
    assert.equal(privacyPoolsFeeWei(gas, price), (gas * price * 12n) / 10n);
  });

  it("adds one ETH withdrawal plus the forward when a second note is needed", () => {
    const single = privacyPoolsRequiredGas({
      isErc20: false,
      extraWithdrawals: 0,
      hasUserTailCalls: false,
    });
    const batched = privacyPoolsRequiredGas({
      isErc20: false,
      extraWithdrawals: 1,
      hasUserTailCalls: false,
    });
    assert.equal(
      batched - single,
      PP_PAYMASTER_GAS.perExtraWithdraw + PP_PAYMASTER_GAS.forwardGas
    );
  });

  it("treats the fee as overhead on top of the net the recipient receives", () => {
    const net = 1_000_000n;
    const fee = privacyPoolsFeeWei(
      privacyPoolsRequiredGas({
        isErc20: false,
        extraWithdrawals: 1,
        hasUserTailCalls: false,
      }),
      price
    );
    assert.equal(net + fee - fee, net);
    assert.ok(fee > 0n);
  });
});

describe("privacyPoolsPayoutTailCalls", () => {
  it("forwards the net minus tail value, then the user calls", () => {
    const user = {
      to: "0x3333333333333333333333333333333333333333" as const,
      data: "0xabcd" as const,
      value: 100n,
    };
    assert.deepEqual(
      privacyPoolsPayoutTailCalls({
        recipient: RECIPIENT,
        net: 1_000n,
        isEth: true,
        token: TOKEN,
        userTailCalls: [user],
      }),
      [
        { to: RECIPIENT, data: "0x", value: 900n },
        user,
      ]
    );
  });

  it("forwards an ERC-20 transfer of the full net when tails have no value", () => {
    const user = {
      to: "0x3333333333333333333333333333333333333333" as const,
      data: "0xabcd" as const,
      value: 0n,
    };
    const [forward, tail] = privacyPoolsPayoutTailCalls({
      recipient: RECIPIENT,
      net: 1_000n,
      isEth: false,
      token: TOKEN,
      userTailCalls: [user],
    });
    assert.deepEqual(
      forward,
      encodeTornadoErc20TransferTailCall(TOKEN, RECIPIENT, 1_000n)
    );
    assert.equal(tail, user);
  });

  it("rejects ERC-20 tails that include msg.value", () => {
    assert.throws(
      () =>
        privacyPoolsPayoutTailCalls({
          recipient: RECIPIENT,
          net: 1_000n,
          isEth: false,
          token: TOKEN,
          userTailCalls: [
            {
              to: RECIPIENT,
              data: "0x",
              value: 1n,
            },
          ],
        }),
      /cannot include msg.value/
    );
  });

  it("rejects tail value above the net", () => {
    assert.throws(
      () =>
        privacyPoolsPayoutTailCalls({
          recipient: RECIPIENT,
          net: 10n,
          isEth: true,
          token: TOKEN,
          userTailCalls: [{ to: RECIPIENT, data: "0x", value: 11n }],
        }),
      /exceeds the unshield amount/
    );
  });
});

describe("privacy pools paymaster config", () => {
  it("is configured for mainnet ETH and missing on Sepolia", () => {
    const mainnet = assertPrivacyPoolsPaymasterConfigured(1n);
    assert.equal(
      privacyPoolsAdapterForPool(1n, ETH_POOL),
      mainnet.poolsAccountsMap[ETH_POOL]
    );
    assert.equal(
      privacyPoolsAdapterForPool(1n, "0x0000000000000000000000000000000000000001"),
      undefined
    );
    assert.throws(
      () => assertPrivacyPoolsPaymasterConfigured(11155111n),
      /privacy pools unshields do not currently work on sepolia testnet \(no paymaster contract\)/
    );
  });
});

describe("privacy pools shield limits", () => {
  it("computes the vetting fee from basis points", () => {
    assert.equal(privacyPoolsVettingFee(10_000n, 25n), 25n);
    assert.equal(privacyPoolsVettingFee(10_000n, 0n), 0n);
  });

  it("rejects a deposit below the pool minimum", () => {
    assert.throws(
      () => assertPrivacyPoolsMinimumDeposit(99n, 100n, 18, "ETH"),
      /at least/
    );
    assert.doesNotThrow(() =>
      assertPrivacyPoolsMinimumDeposit(100n, 100n, 18, "ETH")
    );
  });
});
