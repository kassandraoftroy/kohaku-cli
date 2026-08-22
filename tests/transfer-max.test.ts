import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { transferMaxAmountFromBalance } from "../src/utils/transfer-max.js";

describe("transferMaxAmountFromBalance", () => {
  it("returns the full ERC-20 balance", () => {
    assert.equal(
      transferMaxAmountFromBalance(1_000n, { isEth: false }),
      1_000n
    );
  });

  it("floors a non-positive ERC-20 balance at 0", () => {
    assert.equal(transferMaxAmountFromBalance(0n, { isEth: false }), 0n);
  });

  it("subtracts the ETH gas reserve from native balance", () => {
    assert.equal(
      transferMaxAmountFromBalance(1_000n, {
        isEth: true,
        ethGasReserveWei: 210n,
      }),
      790n
    );
  });

  it("returns 0 when ETH cannot cover the gas reserve", () => {
    assert.equal(
      transferMaxAmountFromBalance(100n, {
        isEth: true,
        ethGasReserveWei: 100n,
      }),
      0n
    );
    assert.equal(
      transferMaxAmountFromBalance(50n, {
        isEth: true,
        ethGasReserveWei: 100n,
      }),
      0n
    );
  });

  it("treats a missing ETH reserve as 0", () => {
    assert.equal(transferMaxAmountFromBalance(500n, { isEth: true }), 500n);
  });
});
