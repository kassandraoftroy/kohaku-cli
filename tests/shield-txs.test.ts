import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { encodeFunctionData, getAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import {
  parseFromIndex,
  partitionShieldTxs,
  resolveShieldSender,
  toShieldTxs,
  tryDecodeErc20Approve,
  type ShieldCall,
} from "../src/lib/shield-flow.js";
import { makeStealthAccountsStorage } from "../src/lib/stealth/storage.js";
import { ERC20_ABI } from "../src/utils/tokens-util.js";
import { addressFromPrivateKey } from "../src/utils/viem-tx.js";

const TOKEN = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const POOL_A = getAddress("0x12d66f87a04a9e220743712ce6d9bb1b5616b8fc");
const POOL_B = getAddress("0x47ce0c6ed5b0ce3d3a51fdb1c52dc66a7c3c2936");
const OTHER = "0x9dAEf1EA5CC90C0F9DA9a5F0B49DA10510c34502";

function approveCall(spender: string, amount: bigint): ShieldCall {
  return {
    to: TOKEN,
    value: 0n,
    data: encodeFunctionData({
      abi: ERC20_ABI,
      functionName: "approve",
      args: [spender as `0x${string}`, amount],
    }),
  };
}

function depositCall(to: string, value = 0n): ShieldCall {
  return { to, data: "0xdead", value };
}

const MNEMONIC =
  "test test test test test test test test test test test junk";
const STEALTH_PRIV =
  "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Hex;
const STEALTH_ADDRESS = privateKeyToAccount(STEALTH_PRIV).address;

function withWalletDir(fn: (walletDir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "kohaku-shield-from-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("parseFromIndex", () => {
  it("parses a non-negative decimal HD index", () => {
    assert.equal(parseFromIndex("0"), 0);
    assert.equal(parseFromIndex("12"), 12);
  });

  it("does not treat a stealth selector as an HD index", () => {
    assert.equal(parseFromIndex("s0"), null);
    assert.equal(parseFromIndex("stealth:0"), null);
  });

  it("rejects signed or empty values", () => {
    assert.equal(parseFromIndex("-1"), null);
    assert.equal(parseFromIndex(""), null);
    assert.equal(parseFromIndex("1.5"), null);
  });
});

describe("resolveShieldSender stealth --from", () => {
  const senderOpts = (walletDir: string, fromValue: string, dryRun = false) => ({
    fromValue,
    walletDir,
    mnemonic: MNEMONIC,
    password: "pw",
    dryRun,
    allowDeriveFromMnemonic: false,
  });

  it("resolves --from s0 and stealth:0 to the stored stealth key", () => {
    withWalletDir((walletDir) => {
      makeStealthAccountsStorage(walletDir, "pw").upsertAccount({
        address: STEALTH_ADDRESS,
        priv: STEALTH_PRIV,
        ephemeralPublicKey:
          "0x02aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        schemeId: 1,
        lastUpdated: 1,
        ethBalance: "0",
        erc20Balances: {},
      });

      for (const fromValue of ["s0", "S0", "stealth:0"]) {
        const resolved = resolveShieldSender(senderOpts(walletDir, fromValue));
        assert.equal(resolved.senderAddress, getAddress(STEALTH_ADDRESS));
        assert.equal(resolved.senderPrivateKey, STEALTH_PRIV);
      }
    });
  });

  it("resolves --from <stealth address> to the stored stealth key", () => {
    withWalletDir((walletDir) => {
      makeStealthAccountsStorage(walletDir, "pw").upsertAccount({
        address: STEALTH_ADDRESS,
        priv: STEALTH_PRIV,
        ephemeralPublicKey:
          "0x02aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        schemeId: 1,
        lastUpdated: 1,
        ethBalance: "0",
        erc20Balances: {},
      });

      for (const fromValue of [STEALTH_ADDRESS, STEALTH_ADDRESS.toLowerCase()]) {
        const resolved = resolveShieldSender(
          senderOpts(walletDir, fromValue, false)
        );
        assert.equal(resolved.senderAddress, getAddress(STEALTH_ADDRESS));
        assert.equal(resolved.senderPrivateKey, STEALTH_PRIV);
      }
    });
  });

  it("rejects a missing stealth selector", () => {
    withWalletDir((walletDir) => {
      assert.throws(
        () => resolveShieldSender(senderOpts(walletDir, "s0")),
        /Stealth account s0 not found/
      );
    });
  });

  it("still derives an HD index on dry-run when the public account is missing", () => {
    withWalletDir((walletDir) => {
      const resolved = resolveShieldSender(senderOpts(walletDir, "0", true));
      assert.equal(
        resolved.senderAddress,
        addressFromPrivateKey(
          // index 0 of the well-known test mnemonic
          "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
        )
      );
      assert.ok(resolved.senderPrivateKey);
    });
  });
});

describe("tryDecodeErc20Approve", () => {
  it("decodes spender and amount from approve calldata", () => {
    const data = encodeFunctionData({
      abi: ERC20_ABI,
      functionName: "approve",
      args: [POOL_A, 1_000n],
    });
    assert.deepEqual(tryDecodeErc20Approve(data), {
      spender: getAddress(POOL_A),
      amount: 1_000n,
    });
  });

  it("returns null for non-approve calldata", () => {
    assert.equal(tryDecodeErc20Approve("0x"), null);
    assert.equal(tryDecodeErc20Approve("0xdeadbeef"), null);
  });
});

describe("partitionShieldTxs", () => {
  it("aggregates plugin approve amounts per spender and keeps deposits", () => {
    const txs = [
      approveCall(POOL_A, 100n),
      depositCall(POOL_A, 100n),
      approveCall(POOL_A, 100n),
      depositCall(POOL_A, 100n),
      approveCall(POOL_B, 1_000n),
      depositCall(POOL_B, 1_000n),
    ];
    const { deposits, approvalNeededBySpender, approvalToken } =
      partitionShieldTxs(txs);
    assert.equal(approvalToken, getAddress(TOKEN));
    assert.equal(deposits.length, 3);
    assert.equal(
      approvalNeededBySpender.get(getAddress(POOL_A)),
      200n
    );
    assert.equal(
      approvalNeededBySpender.get(getAddress(POOL_B)),
      1_000n
    );
  });

  it("does not treat a payable approve-shaped call as an approve", () => {
    const payable = { ...approveCall(OTHER, 1n), value: 1n };
    const { deposits, approvalNeededBySpender } = partitionShieldTxs([
      payable,
    ]);
    assert.equal(deposits.length, 1);
    assert.equal(approvalNeededBySpender.size, 0);
  });
});

describe("toShieldTxs", () => {
  it("accepts a raw array or a { txns } envelope", () => {
    const call = depositCall(OTHER);
    assert.deepEqual(toShieldTxs([call]), [call]);
    assert.deepEqual(toShieldTxs({ txns: [call] }), [call]);
  });

  it("rejects an empty or unknown prepareShield shape", () => {
    assert.throws(() => toShieldTxs([]), /no transactions/);
    assert.throws(() => toShieldTxs({}), /Unsupported shield operation/);
  });
});
