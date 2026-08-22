import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  RAILGUN_UNSHIELD_GAS_UNITS,
  estimateRailgunBundlerFeeWei,
  isRailgunFeeToken,
  railgunMaxReceivableFromBalance,
} from "../src/utils/railgun-unshield-max.js";

const DAI = "0x6B175474E89094C44Da98b954EedeAC495271d0F";

describe("railgunMaxReceivableFromBalance", () => {
  it("subtracts the reserve then takes the treasury BPS from the remainder", () => {
    // Recipient gets floor((balance - reserve) * (10000 - bps) / 10000).
    assert.equal(railgunMaxReceivableFromBalance(1000n, 25, 100n), 897n);
  });

  it("returns 0 when the reserve consumes the whole balance", () => {
    assert.equal(railgunMaxReceivableFromBalance(100n, 25, 100n), 0n);
    assert.equal(railgunMaxReceivableFromBalance(99n, 25, 100n), 0n);
  });

  it("returns 0 when the unshield fee is 100% or more", () => {
    assert.equal(railgunMaxReceivableFromBalance(1_000n, 10_000, 0n), 0n);
    assert.equal(railgunMaxReceivableFromBalance(1_000n, 10_001, 0n), 0n);
  });

  it("leaves the full remainder when the treasury fee is 0", () => {
    assert.equal(railgunMaxReceivableFromBalance(500n, 0, 50n), 450n);
  });
});

describe("estimateRailgunBundlerFeeWei", () => {
  const baselineGas =
    RAILGUN_UNSHIELD_GAS_UNITS.verificationGasLimit +
    RAILGUN_UNSHIELD_GAS_UNITS.callGasLimit +
    RAILGUN_UNSHIELD_GAS_UNITS.paymasterVerificationGasLimit +
    RAILGUN_UNSHIELD_GAS_UNITS.preVerificationGas +
    RAILGUN_UNSHIELD_GAS_UNITS.paymasterPostOpGasLimit;

  it("applies the 1.2× safety margin to the static UserOp gas units", () => {
    assert.equal(estimateRailgunBundlerFeeWei(1n), (baselineGas * 12n) / 10n);
    assert.equal(
      estimateRailgunBundlerFeeWei(10n),
      (baselineGas * 10n * 12n) / 10n
    );
  });

  it("adds native-unwrap call gas on top of the baseline, not instead of it", () => {
    const withUnwrap =
      baselineGas + RAILGUN_UNSHIELD_GAS_UNITS.nativeUnwrapCallGas;
    assert.equal(
      estimateRailgunBundlerFeeWei(1n, { nativeUnwrap: true }),
      (withUnwrap * 12n) / 10n
    );
  });

  it("adds measured tail-call gas on top of the call-gas baseline", () => {
    const tail = 50_000n;
    const withTail = baselineGas + tail;
    assert.equal(
      estimateRailgunBundlerFeeWei(1n, { tailCallsGasEstimate: tail }),
      (withTail * 12n) / 10n
    );
  });
});

describe("isRailgunFeeToken", () => {
  it("treats native ETH as the fee token on every chain", () => {
    assert.equal(
      isRailgunFeeToken({ isEth: true, tokenAddress: DAI }, 1n),
      true
    );
  });
});
