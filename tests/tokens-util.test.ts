import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress } from "viem";

import { mapPrivateBalanceRows } from "../src/lib/private-balance-rows.js";
import { ETH_AS_ERC20 } from "../src/utils/plugins.js";
import {
  isPendingPrivateBalanceRow,
  isPrivateBalanceNativeEth,
  isSpendablePrivateBalanceTag,
  mergeDefaultAndExtraErc20s,
  privateBalanceRowMatchesUnshieldToken,
  privateBalanceStatusLabel,
  wethAddressForChain,
} from "../src/utils/tokens-util.js";

const DAI = "0x6B175474E89094C44Da98b954EedeAC495271d0F";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

describe("isPrivateBalanceNativeEth", () => {
  it("recognizes the EEE… sentinel and zero-address variants", () => {
    assert.equal(isPrivateBalanceNativeEth(ETH_AS_ERC20), true);
    assert.equal(isPrivateBalanceNativeEth(ETH_AS_ERC20.toUpperCase()), true);
    assert.equal(
      isPrivateBalanceNativeEth("0x0000000000000000000000000000000000000000"),
      true
    );
    assert.equal(isPrivateBalanceNativeEth("0x00"), true);
    assert.equal(isPrivateBalanceNativeEth(DAI), false);
    assert.equal(isPrivateBalanceNativeEth("eth"), false);
  });
});

describe("private balance tags", () => {
  it("treats missing/Valid as spendable and Missing as pending", () => {
    assert.equal(isSpendablePrivateBalanceTag(undefined), true);
    assert.equal(isSpendablePrivateBalanceTag("Valid"), true);
    assert.equal(isSpendablePrivateBalanceTag("Missing"), false);
    assert.equal(isSpendablePrivateBalanceTag("pending"), false);
    assert.equal(isPendingPrivateBalanceRow({}), false);
    assert.equal(isPendingPrivateBalanceRow({ tag: "Missing" }), true);
    assert.equal(privateBalanceStatusLabel("Missing"), "pending");
    assert.equal(privateBalanceStatusLabel("Valid"), "spendable");
  });
});

describe("privateBalanceRowMatchesUnshieldToken", () => {
  it("matches Railgun ETH against WETH, including mixed case", () => {
    const weth = wethAddressForChain(1n)!;
    assert.equal(
      privateBalanceRowMatchesUnshieldToken(
        weth.toLowerCase(),
        { isEth: true, tokenAddress: ETH_AS_ERC20 },
        1n,
        "railgun"
      ),
      true
    );
    assert.equal(
      privateBalanceRowMatchesUnshieldToken(
        ETH_AS_ERC20,
        { isEth: true, tokenAddress: ETH_AS_ERC20 },
        1n,
        "railgun"
      ),
      false
    );
  });

  it("matches Tornado ETH against the native sentinel, not WETH", () => {
    const weth = wethAddressForChain(1n)!;
    assert.equal(
      privateBalanceRowMatchesUnshieldToken(
        ETH_AS_ERC20,
        { isEth: true, tokenAddress: ETH_AS_ERC20 },
        1n,
        "tornado"
      ),
      true
    );
    assert.equal(
      privateBalanceRowMatchesUnshieldToken(
        weth,
        { isEth: true, tokenAddress: ETH_AS_ERC20 },
        1n,
        "tornado"
      ),
      false
    );
  });

  it("matches ERC-20 rows case-insensitively", () => {
    assert.equal(
      privateBalanceRowMatchesUnshieldToken(
        DAI.toLowerCase(),
        { isEth: false, tokenAddress: DAI },
        1n
      ),
      true
    );
    assert.equal(
      privateBalanceRowMatchesUnshieldToken(
        USDC,
        { isEth: false, tokenAddress: DAI },
        1n
      ),
      false
    );
  });
});

describe("mapPrivateBalanceRows", () => {
  it("pads a bigint contract to 40 hex chars and looks up checksummed meta", () => {
    const daiBig = BigInt(DAI);
    const rows = mapPrivateBalanceRows(
      [
        {
          asset: { __type: "erc20", contract: daiBig },
          amount: 1_000n,
        } as never,
      ],
      new Map([[DAI.toLowerCase(), { symbol: "DAI", decimals: 18 }]])
    );
    assert.equal(rows[0]!.symbol, "DAI");
    assert.equal(rows[0]!.token_address, getAddress(DAI));
    assert.equal(rows[0]!.raw_token_holdings, "1000");
    assert.equal(rows[0]!.status, "spendable");
  });

  it("marks a pending native-ETH row", () => {
    const rows = mapPrivateBalanceRows(
      [
        {
          asset: { __type: "erc20", contract: ETH_AS_ERC20 },
          amount: 1n,
          tag: "Missing",
        } as never,
      ],
      new Map()
    );
    assert.equal(rows[0]!.symbol, "ETH (pending)");
    assert.equal(rows[0]!.token_address, "---");
    assert.equal(rows[0]!.status, "pending");
  });
});

describe("mergeDefaultAndExtraErc20s", () => {
  it("dedupes mixed-case extras against chain defaults", () => {
    const merged = mergeDefaultAndExtraErc20s("1", [
      USDC.toLowerCase() as `0x${string}`,
      "0x1111111111111111111111111111111111111111",
    ]);
    const usdcCount = merged.erc20Addresses.filter(
      (a) => a.toLowerCase() === USDC.toLowerCase()
    ).length;
    assert.equal(usdcCount, 1);
    assert.ok(
      merged.erc20Addresses.some(
        (a) => a.toLowerCase() === "0x1111111111111111111111111111111111111111"
      )
    );
    assert.equal(merged.knownMetaByLower.get(USDC.toLowerCase())?.symbol, "USDC");
  });
});
