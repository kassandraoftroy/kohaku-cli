import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  computeShieldMaxAmount,
  eoaShieldFeeReserveWei,
  eoaShieldSendParams,
  paddedShieldGasLimit,
  padShieldFeeWei,
  refineShieldMaxAmount,
  SHIELD_FEE_PAD_DEN,
  SHIELD_FEE_PAD_NUM,
  SHIELD_GAS_LIMIT,
  shieldMaxFeeReserveWei,
  tornadoFloorToMinDenom,
} from "../src/utils/shield-max.js";

const ETH_01 = 100_000_000_000_000_000n; // 0.1
const ETH_02 = 200_000_000_000_000_000n; // 0.2
const ETH_03 = 300_000_000_000_000_000n; // 0.3
const ETH_035 = 350_000_000_000_000_000n; // 0.35
const ETH_002 = 20_000_000_000_000_000n; // 0.02
const ETH_006 = 60_000_000_000_000_000n; // 0.06
const DAI_100 = 100_000_000_000_000_000_000n;
const DAI_200 = 200_000_000_000_000_000_000n;
const DAI_250 = 250_000_000_000_000_000_000n;

describe("tornadoFloorToMinDenom", () => {
  it("floors down to a multiple of minDenom", () => {
    assert.equal(tornadoFloorToMinDenom(DAI_250, DAI_100), DAI_200);
    assert.equal(tornadoFloorToMinDenom(ETH_035, ETH_01), ETH_03);
  });

  it("returns 0 when amount is below minDenom", () => {
    assert.equal(tornadoFloorToMinDenom(50n, DAI_100), 0n);
    assert.equal(tornadoFloorToMinDenom(0n, ETH_01), 0n);
  });
});

describe("computeShieldMaxAmount", () => {
  it("returns the full ERC-20 balance for railgun / privacy-pools", () => {
    const { amount } = computeShieldMaxAmount({
      isEth: false,
      protocol: "railgun",
      tokenBalance: DAI_250,
      ethBalance: ETH_01,
      gasReserveWei: ETH_002,
    });
    assert.equal(amount, DAI_250);
  });

  it("floors Tornado ERC-20 to the smallest denomination", () => {
    const { amount } = computeShieldMaxAmount({
      isEth: false,
      protocol: "tornado",
      tokenBalance: DAI_250,
      ethBalance: ETH_01,
      gasReserveWei: ETH_002,
      minDenom: DAI_100,
    });
    assert.equal(amount, DAI_200);
  });

  it("subtracts the gas reserve from ETH for railgun / privacy-pools", () => {
    const { amount } = computeShieldMaxAmount({
      isEth: true,
      protocol: "railgun",
      tokenBalance: ETH_035,
      ethBalance: ETH_035,
      gasReserveWei: ETH_002,
    });
    assert.equal(amount, ETH_035 - ETH_002);
  });

  it("floors Tornado ETH after reserving gas (0.35 - 0.02 → 0.3)", () => {
    const { amount } = computeShieldMaxAmount({
      isEth: true,
      protocol: "tornado",
      tokenBalance: ETH_035,
      ethBalance: ETH_035,
      gasReserveWei: ETH_002,
      minDenom: ETH_01,
    });
    assert.equal(amount, ETH_03);
  });

  it("returns 0 when the ETH reserve covers the whole balance", () => {
    const { amount } = computeShieldMaxAmount({
      isEth: true,
      protocol: "railgun",
      tokenBalance: ETH_002,
      ethBalance: ETH_002,
      gasReserveWei: ETH_002,
    });
    assert.equal(amount, 0n);
  });

  it("returns 0 when Tornado leftover is below min denom", () => {
    const { amount } = computeShieldMaxAmount({
      isEth: true,
      protocol: "tornado",
      tokenBalance: 50_000_000_000_000_000n,
      ethBalance: 50_000_000_000_000_000n,
      gasReserveWei: ETH_002,
      minDenom: ETH_01,
    });
    assert.equal(amount, 0n);
  });

  it("returns 0 for ERC-20 when ETH cannot cover the gas reserve", () => {
    const { amount } = computeShieldMaxAmount({
      isEth: false,
      protocol: "railgun",
      tokenBalance: DAI_250,
      ethBalance: 1n,
      gasReserveWei: ETH_002,
    });
    assert.equal(amount, 0n);
  });
});

describe("refineShieldMaxAmount", () => {
  it("keeps the amount when ETH value + fee fits", () => {
    assert.equal(
      refineShieldMaxAmount({
        isEth: true,
        protocol: "tornado",
        currentAmount: ETH_03,
        ethBalance: ETH_035,
        estimatedFeeWei: ETH_002,
        minDenom: ETH_01,
      }),
      ETH_03
    );
  });

  it("drops a Tornado ETH step when fee pushes leftover under 0.3 → 0.2", () => {
    assert.equal(
      refineShieldMaxAmount({
        isEth: true,
        protocol: "tornado",
        currentAmount: ETH_03,
        ethBalance: ETH_035,
        estimatedFeeWei: ETH_006,
        minDenom: ETH_01,
      }),
      ETH_02
    );
  });

  it("does not shrink ERC-20 when ETH covers the fee", () => {
    assert.equal(
      refineShieldMaxAmount({
        isEth: false,
        protocol: "tornado",
        currentAmount: DAI_200,
        ethBalance: ETH_01,
        estimatedFeeWei: ETH_002,
        minDenom: DAI_100,
      }),
      DAI_200
    );
  });

  it("returns 0 for ERC-20 when ETH cannot cover the fee", () => {
    assert.equal(
      refineShieldMaxAmount({
        isEth: false,
        protocol: "railgun",
        currentAmount: DAI_200,
        ethBalance: 1n,
        estimatedFeeWei: ETH_002,
      }),
      0n
    );
  });

  it("returns 0 when leftover after fee is below Tornado min denom", () => {
    assert.equal(
      refineShieldMaxAmount({
        isEth: true,
        protocol: "tornado",
        currentAmount: ETH_01,
        ethBalance: ETH_01,
        estimatedFeeWei: ETH_002,
        minDenom: ETH_01,
      }),
      0n
    );
  });
});

describe("padShieldFeeWei / eoaShieldSendParams", () => {
  it("pads 1.3×", () => {
    assert.equal(SHIELD_FEE_PAD_NUM, 13n);
    assert.equal(SHIELD_FEE_PAD_DEN, 10n);
    assert.equal(padShieldFeeWei(1000n), 1300n);
    assert.equal(paddedShieldGasLimit(1_000_000n), 1_300_000n);
    assert.equal(paddedShieldGasLimit(SHIELD_GAS_LIMIT), SHIELD_GAS_LIMIT);
  });

  it("EOA refine reserve uses padded estimateGas, not the 2M cap", () => {
    const maxFeePerGas = 117_279_367n;
    const estimateGas = 1_088_123n;
    const reserved = shieldMaxFeeReserveWei({
      batch: false,
      estimatedMaxWei: estimateGas * maxFeePerGas,
      maxFeePerGasWei: maxFeePerGas,
      gasLimit: estimateGas,
    });
    const sendGas = paddedShieldGasLimit(estimateGas);
    assert.equal(reserved, padShieldFeeWei(sendGas * maxFeePerGas));
    assert.ok(reserved < eoaShieldFeeReserveWei(maxFeePerGas));
  });

  it("first-pass (no estimateGas) still reserves against the 2M cap", () => {
    const maxFeePerGas = 117_279_367n;
    const reserved = shieldMaxFeeReserveWei({
      batch: false,
      estimatedMaxWei: 1n,
      maxFeePerGasWei: maxFeePerGas,
    });
    assert.equal(reserved, eoaShieldFeeReserveWei(maxFeePerGas));
  });

  it("send gas matches padded estimateGas so a 2M node check is not required", () => {
    const balance = 16_235_115_418_919_695n;
    const value = 16_012_153_622_719_695n;
    const estimateGas = 803_525n;
    const sendMaxFee = 156_485_998n;
    const params = eoaShieldSendParams({
      estimatedGas: estimateGas,
      maxFeePerGas: sendMaxFee,
      maxPriorityFeePerGas: 94_426n,
      value,
      balance,
    });
    assert.equal(params.gas, paddedShieldGasLimit(estimateGas));
    assert.equal(params.maxFeePerGas, sendMaxFee);
    assert.ok(params.gas * params.maxFeePerGas + value <= balance);
    assert.ok(SHIELD_GAS_LIMIT * sendMaxFee + value > balance);
  });

  it("caps maxFeePerGas when even padded gas × fee would exceed leftover ETH", () => {
    const balance = 16_235_115_418_919_695n;
    const value = 16_012_153_622_719_695n;
    const params = eoaShieldSendParams({
      estimatedGas: 803_525n,
      maxFeePerGas: 500_000_000n,
      maxPriorityFeePerGas: 94_426n,
      value,
      balance,
    });
    assert.ok(params.maxFeePerGas < 500_000_000n);
    assert.ok(params.maxFeePerGas > 0n);
    assert.ok(params.gas * params.maxFeePerGas + value <= balance);
  });

  it("batch UserOp reserve pads the bundler estimate", () => {
    const estimatedMax = 50_000_000_000_000n;
    assert.equal(
      shieldMaxFeeReserveWei({ batch: true, estimatedMaxWei: estimatedMax }),
      padShieldFeeWei(estimatedMax)
    );
  });
});
