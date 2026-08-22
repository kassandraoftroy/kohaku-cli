import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  assertTornadoDepositAmount,
  assertTornadoExactPoolDenomination,
  assertTornadoTokenSupported,
  assertTornadoUnshieldAmountForToken,
  tornadoPaymasterPoolsForAsset,
  tornadoPoolsForAsset,
  tornadoPoolsForChain,
} from "../src/utils/tornado-pools.js";

const ETH = {
  isEth: true,
  tokenAddress: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
  symbol: "ETH",
  decimals: 18,
};
const DAI = {
  isEth: false,
  tokenAddress: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
  symbol: "DAI",
  decimals: 18,
};
const USDC = {
  isEth: false,
  tokenAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  symbol: "USDC",
  decimals: 6,
};
const UNKNOWN = {
  isEth: false,
  tokenAddress: "0x0000000000000000000000000000000000000001",
  symbol: "FAKE",
  decimals: 18,
};

const ETH_01 = 100_000_000_000_000_000n; // 0.1
const ETH_1 = 1_000_000_000_000_000_000n;
const ETH_02 = 200_000_000_000_000_000n; // 0.2 — multiple of 0.1, not an exact pool
const USDC_100 = 100_000_000n;
const USDC_200 = 200_000_000n;

describe("tornadoPoolsForChain", () => {
  it("returns mainnet and Sepolia catalogs and nothing else", () => {
    assert.ok(tornadoPoolsForChain(1n).length > 0);
    assert.ok(tornadoPoolsForChain(11155111n).length > 0);
    assert.deepEqual(tornadoPoolsForChain(10n), []);
  });
});

describe("tornadoPoolsForAsset", () => {
  it("matches ETH vs ERC-20, including mixed-case token addresses", () => {
    const eth = tornadoPoolsForAsset(1n, { isEth: true });
    assert.ok(eth.every((p) => !p.isERC20));
    assert.ok(eth.some((p) => p.denomination === ETH_01));

    const dai = tornadoPoolsForAsset(1n, {
      isEth: false,
      tokenAddress: DAI.tokenAddress.toLowerCase(),
    });
    assert.ok(dai.length > 0);
    assert.ok(dai.every((p) => p.asset === "DAI"));

    const usdc = tornadoPoolsForAsset(1n, {
      isEth: false,
      tokenAddress: USDC.tokenAddress,
    });
    assert.ok(usdc.every((p) => p.decimals === 6));
  });
});

describe("assertTornadoTokenSupported", () => {
  it("throws for an unknown token or chain with no pools", () => {
    assert.throws(
      () => assertTornadoTokenSupported(1n, UNKNOWN),
      /not in the Tornado Cash pool catalog/
    );
    assert.throws(
      () => assertTornadoTokenSupported(10n, ETH),
      /no ETH pools/
    );
  });
});

describe("assertTornadoDepositAmount", () => {
  it("accepts a positive multiple of the smallest ETH denomination", () => {
    assert.doesNotThrow(() => assertTornadoDepositAmount(1n, ETH_01, ETH));
    assert.doesNotThrow(() => assertTornadoDepositAmount(1n, ETH_1, ETH));
    assert.doesNotThrow(() => assertTornadoDepositAmount(1n, ETH_02, ETH));
  });

  it("rejects amounts that are not a multiple of the smallest pool", () => {
    assert.throws(
      () => assertTornadoDepositAmount(1n, ETH_01 / 2n, ETH),
      /exact multiple of 0.1 ETH/
    );
  });

  it("uses 6-decimal USDC denominations", () => {
    assert.doesNotThrow(() => assertTornadoDepositAmount(1n, USDC_100, USDC));
    assert.doesNotThrow(() => assertTornadoDepositAmount(1n, USDC_200, USDC));
    assert.throws(
      () => assertTornadoDepositAmount(1n, 50_000_000n, USDC),
      /exact multiple of 100 USDC/
    );
  });

  it("rejects zero", () => {
    assert.throws(
      () => assertTornadoDepositAmount(1n, 0n, ETH),
      /greater than zero/
    );
  });
});

describe("assertTornadoExactPoolDenomination", () => {
  it("accepts an exact pool size and rejects a mere multiple", () => {
    assert.equal(
      assertTornadoExactPoolDenomination(1n, ETH_1, ETH).denomination,
      ETH_1
    );
    assert.throws(
      () => assertTornadoExactPoolDenomination(1n, ETH_02, ETH),
      /not an exact Tornado pool denomination/
    );
  });
});

describe("assertTornadoUnshieldAmountForToken", () => {
  it("accepts a multiple of the smallest paymaster-backed denomination", () => {
    assert.doesNotThrow(() =>
      assertTornadoUnshieldAmountForToken(1n, ETH_02, ETH)
    );
    assert.doesNotThrow(() =>
      assertTornadoUnshieldAmountForToken(1n, USDC_100, USDC)
    );
  });

  it("rejects a non-multiple of the paymaster-backed minimum", () => {
    assert.throws(
      () => assertTornadoUnshieldAmountForToken(1n, ETH_01 / 2n, ETH),
      /smallest paymaster-backed pool denomination/
    );
  });
});

describe("tornadoPaymasterPoolsForAsset", () => {
  it("is a subset of the deposit catalog", () => {
    const deposit = tornadoPoolsForAsset(1n, { isEth: true });
    const paymaster = tornadoPaymasterPoolsForAsset(1n, { isEth: true });
    assert.ok(paymaster.length > 0);
    const depositAddrs = new Set(deposit.map((p) => p.poolAddress.toLowerCase()));
    for (const p of paymaster) {
      assert.ok(depositAddrs.has(p.poolAddress.toLowerCase()));
    }
  });
});
