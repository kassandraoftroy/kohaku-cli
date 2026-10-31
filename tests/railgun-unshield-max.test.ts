import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  RAILGUN_UNSHIELD_GAS_UNITS,
  estimateRailgunBundlerFeeWei,
  isRailgunFeeToken,
  railgunMaxReceivableFromBalance,
  railgunTreasuryFee,
} from "../src/utils/railgun-unshield-max.js";

const DAI = "0x6B175474E89094C44Da98b954EedeAC495271d0F";

describe("railgunMaxReceivableFromBalance", () => {
  it("subtracts the reserve then takes the treasury BPS from the remainder", () => {
    // Railgun subtracts floor(gross * bps / 10000), so 900 gross delivers 898.
    assert.equal(railgunMaxReceivableFromBalance(1000n, 25, 100n), 898n);
    assert.equal(railgunMaxReceivableFromBalance(1n, 25, 0n), 1n);
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

describe("railgunTreasuryFee", () => {
  it("matches Rust gross-up rounding for the requested net amount", () => {
    assert.equal(railgunTreasuryFee(9_975n, 25), 24n);
    assert.equal(railgunTreasuryFee(1n, 25), 0n);
    assert.equal(railgunTreasuryFee(1000n, 25), 2n);
    // A 0.31 ETH unshield previously delivered one extra wei of WETH.
    assert.equal(
      railgunTreasuryFee(310_000_000_000_000_000n, 25),
      776_942_355_889_724n
    );
  });

  it("spends no more than the available gross and delivers the requested net", () => {
    for (const feeBps of [0, 1, 25, 50, 500, 5000]) {
      for (let available = 1n; available <= 1000n; available++) {
        const requested = railgunMaxReceivableFromBalance(available, feeBps, 0n);
        const gross = requested + railgunTreasuryFee(requested, feeBps);
        assert.ok(gross <= available);
        assert.equal(gross - (gross * BigInt(feeBps)) / 10_000n, requested);
      }
    }
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
