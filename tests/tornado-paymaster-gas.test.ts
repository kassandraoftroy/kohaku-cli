import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  TAIL_FORWARD_FEE_PAD_DEN,
  TAIL_FORWARD_FEE_PAD_NUM,
  estimateTornadoPaymasterFee,
  padTornadoTailForwardFee,
  tornadoWithdrawalCallGasLimit,
} from "../src/utils/tornado-paymaster-gas.js";
import { withTailCallsGasOverhead } from "../src/utils/tornado-tail-gas.js";

describe("tornadoWithdrawalCallGasLimit", () => {
  it("defaults extra-note gas to the 300k execution-tail baseline", () => {
    assert.equal(tornadoWithdrawalCallGasLimit(0), 300_000n);
    assert.equal(tornadoWithdrawalCallGasLimit(1), 700_000n);
    assert.equal(tornadoWithdrawalCallGasLimit(2), 1_100_000n);
  });

  it("uses the ERC-20 per-withdraw constant when isERC20", () => {
    assert.equal(tornadoWithdrawalCallGasLimit(1, undefined, true), 800_000n);
    assert.equal(tornadoWithdrawalCallGasLimit(2, undefined, true), 1_300_000n);
  });

  it("adds a measured execution tail instead of the 300k default", () => {
    assert.equal(tornadoWithdrawalCallGasLimit(0, 50_000n), 50_000n);
    assert.equal(tornadoWithdrawalCallGasLimit(1, 50_000n, true), 550_000n);
  });

  it("treats a negative extra-withdrawals count as zero extra notes", () => {
    assert.equal(tornadoWithdrawalCallGasLimit(-3), 300_000n);
  });
});

describe("estimateTornadoPaymasterFee", () => {
  it("applies the SDK 1.2× safety margin to ETH withdrawal gas", () => {
    // 50k + 300k + 350k + 80k + 50k = 830k
    assert.equal(estimateTornadoPaymasterFee(1n), (830_000n * 12n) / 10n);
  });

  it("adds ERC-20 transfer gas onto paymaster verification", () => {
    // 50k + 300k + 450k + 80k + 50k = 930k
    assert.equal(
      estimateTornadoPaymasterFee(1n, { isERC20: true }),
      (930_000n * 12n) / 10n
    );
  });

  it("uses an explicit callGasLimit when provided", () => {
    assert.equal(
      estimateTornadoPaymasterFee(1n, { callGasLimit: 1_000_000n }),
      ((50_000n + 1_000_000n + 350_000n + 80_000n + 50_000n) * 12n) / 10n
    );
  });
});

describe("padTornadoTailForwardFee", () => {
  it("pads 23/20 (15%), not the 1.2× gas margin", () => {
    assert.equal(TAIL_FORWARD_FEE_PAD_NUM, 23n);
    assert.equal(TAIL_FORWARD_FEE_PAD_DEN, 20n);
    assert.equal(padTornadoTailForwardFee(1000n), 1150n);
    assert.notEqual(padTornadoTailForwardFee(1000n), (1000n * 12n) / 10n);
  });
});

describe("withTailCallsGasOverhead", () => {
  it("adds 10% headroom on measured execution-tail gas", () => {
    assert.equal(withTailCallsGasOverhead(1000n), 1100n);
    assert.equal(withTailCallsGasOverhead(0n), 0n);
  });
});
