import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TornadoInstances, TornadoPaymasterConfigs, extendedEthPoolSet } from "@kohaku-eth/tornado-cash";

import {
  assertTornadoDepositAmount,
  assertTornadoExactPoolDenomination,
  assertTornadoTokenSupported,
  assertTornadoPaymasterTokenSupported,
  assertTornadoUnshieldAmountForToken,
  tornadoMinDenomination,
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

describe("tornadoMinDenomination", () => {
  it("returns the smallest catalog denomination for ETH and USDC", () => {
    assert.equal(tornadoMinDenomination(1n, ETH), ETH_01 / 10n);
    assert.equal(tornadoMinDenomination(1n, { ...ETH, excludeNewPools: true }), ETH_01);
    assert.equal(tornadoMinDenomination(1n, USDC), USDC_100);
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
      () => assertTornadoDepositAmount(1n, ETH_01 / 20n, ETH),
      /exact multiple of 0.01 ETH/
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

  it("rejects a non-multiple of the selected catalog minimum", () => {
    assert.throws(
      () => assertTornadoUnshieldAmountForToken(1n, ETH_01 / 20n, ETH),
      /smallest pool denomination/
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


describe("extended Tornado pools", () => {
  it("includes all new denominations on each chain, preserving classic pools", () => {
    assert.deepEqual(tornadoPoolsForChain(1n).filter((p) => p.isNew).map((p) => p.denomination),
      [1n, 3n, 30n, 300n, 3000n].map((n) => n * 10n ** 16n));
    assert.equal(tornadoPoolsForChain(11155111n).filter((p) => p.isNew).length, 6);
    assert.equal(tornadoPoolsForAsset(1n, { ...ETH, excludeNewPools: true }).length, 4);
    assert.equal(tornadoPoolsForAsset(11155111n, { ...ETH, excludeNewPools: true }).length, 2);
    assert.deepEqual(tornadoPoolsForAsset(1n, { ...USDC, excludeNewPools: true }), tornadoPoolsForAsset(1n, USDC));
  });

  it("accepts 2.45 ETH by default and rejects it with the opt-out", () => {
    const amount = 245n * 10n ** 16n;
    assert.doesNotThrow(() => assertTornadoDepositAmount(1n, amount, ETH));
    assert.throws(() => assertTornadoDepositAmount(1n, amount, { ...ETH, excludeNewPools: true }), /exact multiple of 0.1 ETH/);
    assert.doesNotThrow(() => assertTornadoDepositAmount(1n, 240n * 10n ** 16n, { ...ETH, excludeNewPools: true }));
  });
});


describe("SDK catalog parity", () => {
  it("preserves metadata for exactly the paymaster-supported SDK pools", () => {
    for (const chainId of [1, 11155111] as const) {
      const pools = tornadoPoolsForChain(BigInt(chainId));
      const supported = new Set(TornadoPaymasterConfigs[chainId].supportedPools.map(BigInt));
      const expected = TornadoInstances[chainId].filter((instance) => supported.has(instance.address));
      assert.equal(pools.length, expected.length);
      const extended = extendedEthPoolSet(BigInt(chainId));
      for (const instance of TornadoInstances[chainId]) {
        const pool = pools.find((pool) => BigInt(pool.poolAddress) === instance.address)!;
        if (!supported.has(instance.address)) {
          assert.equal(pool, undefined);
          continue;
        }
        assert.ok(pool);
        assert.equal(pool.denomination, instance.denomination);
        assert.equal(pool.asset, instance.symbol);
        assert.equal(pool.decimals, instance.decimals);
        assert.equal(pool.isERC20, instance.asset !== 0n);
        assert.equal(pool.assetAddress ? BigInt(pool.assetAddress) : 0n, instance.asset);
        assert.equal(!!pool.isNew, extended.has(instance.address));
      }
    }
  });
});

it("rejects cDAI for both shields and unshields", () => {
  const instances = TornadoInstances[1].filter((instance) => instance.symbol === "cDAI");
  assert.equal(instances.length, 4);
  for (const instance of instances) {
    for (const excludeNewPools of [false, true]) {
      const opts = { isEth: false, tokenAddress: `0x${instance.asset.toString(16).padStart(40, "0")}`, symbol: "cDAI", excludeNewPools };
      assert.deepEqual(tornadoPoolsForAsset(1n, opts), []);
      assert.throws(() => assertTornadoTokenSupported(1n, opts), /not in the Tornado Cash pool catalog/);
      assert.throws(() => assertTornadoPaymasterTokenSupported(1n, opts), /not in the Tornado Cash pool catalog/);
    }
  }
});
