import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { encodeFunctionData, getAddress, parseAbi } from "viem";

import {
  exactTransferTailCall,
  planNonTornadoPrivateTransfer,
  resolveTornadoPrivateTransferCover,
} from "../src/lib/private-transfer.js";
import {
  minimumTornadoNoteSumCovering,
  TornadoCoverError,
  tornadoUnshieldOptions,
  tornadoWithdrawalCountForAmount,
} from "../src/utils/plugins.js";
import { encodeTornadoErc20TransferTailCall } from "../src/utils/tornado-tail-gas.js";

const ONE_TENTH = 10n ** 17n;
const ONE = 10n ** 18n;
const RECIPIENT = getAddress("0x1111111111111111111111111111111111111111");
const PAYEE = getAddress("0x2222222222222222222222222222222222222222");
const TOKEN = getAddress("0x3333333333333333333333333333333333333333");
const PATH = "m/44'/60'/0'/0/0";

describe("minimumTornadoNoteSumCovering", () => {
  it("unshields 0.2 when a 0.1 transfer needs a second note for fees", () => {
    assert.equal(
      minimumTornadoNoteSumCovering([ONE_TENTH, ONE_TENTH], ONE_TENTH + 1n),
      ONE_TENTH * 2n
    );
  });

  it("prefers 0.2 over a 1.0 note", () => {
    assert.equal(
      minimumTornadoNoteSumCovering(
        [ONE, ONE_TENTH, ONE_TENTH],
        ONE_TENTH + 1n
      ),
      ONE_TENTH * 2n
    );
  });

  it("fails when one 0.1 note cannot cover 0.1 plus a fee", () => {
    assert.throws(
      () => minimumTornadoNoteSumCovering([ONE_TENTH], ONE_TENTH + 1n),
      (err: unknown) => {
        assert.ok(err instanceof TornadoCoverError);
        assert.equal(err.target, ONE_TENTH + 1n);
        assert.equal(err.covered, ONE_TENTH);
        return true;
      }
    );
  });

  it("uses the same rule for token denominations", () => {
    const hundred = 100n;
    const thousand = 1000n;
    assert.equal(
      minimumTornadoNoteSumCovering([hundred, hundred, thousand], hundred + 1n),
      hundred * 2n
    );
    assert.throws(
      () => minimumTornadoNoteSumCovering([hundred], hundred + 1n),
      TornadoCoverError
    );
  });

  it("only returns sums the largest-first packer can withdraw", () => {
    const sum = minimumTornadoNoteSumCovering(
      [ONE, ONE_TENTH, ONE_TENTH],
      ONE_TENTH * 2n
    );
    assert.equal(sum, ONE_TENTH * 2n);
    assert.equal(tornadoWithdrawalCountForAmount([ONE, ONE_TENTH, ONE_TENTH], sum), 2);
  });
});

describe("exactTransferTailCall", () => {
  it("encodes an ETH value transfer of the exact amount", () => {
    assert.deepEqual(
      exactTransferTailCall({ isEth: true, tokenAddress: TOKEN }, PAYEE, ONE_TENTH),
      { to: PAYEE, data: "0x", value: ONE_TENTH }
    );
  });

  it("encodes an ERC-20 transfer of the exact amount", () => {
    const expected = encodeFunctionData({
      abi: parseAbi(["function transfer(address to, uint256 amount) returns (bool)"]),
      functionName: "transfer",
      args: [PAYEE, 100n],
    });
    const call = exactTransferTailCall(
      { isEth: false, tokenAddress: TOKEN },
      PAYEE,
      100n
    );
    assert.equal(call.to, TOKEN);
    assert.equal(call.value, 0n);
    assert.equal(call.data, expected);
    assert.deepEqual(
      call,
      encodeTornadoErc20TransferTailCall(TOKEN, PAYEE, 100n)
    );
  });
});

describe("planNonTornadoPrivateTransfer", () => {
  it("unshields and forwards the typed amount for Railgun and Privacy Pools", () => {
    for (const amount of [1n, ONE_TENTH, 25000000n]) {
      const plan = planNonTornadoPrivateTransfer(amount);
      assert.equal(plan.unshieldAmountWei, amount);
      assert.equal(plan.transferAmountWei, amount);
      assert.equal(plan.estimatedLeftoverWei, 0n);
      const tail = exactTransferTailCall(
        { isEth: true, tokenAddress: TOKEN },
        PAYEE,
        plan.transferAmountWei
      );
      assert.equal(tail.value, amount);
    }
  });
});

describe("resolveTornadoPrivateTransferCover", () => {
  it("selects 0.2 to pay 0.1 when the fee is smaller than one note", async () => {
    const cover = await resolveTornadoPrivateTransferCover({
      noteAmounts: [ONE, ONE_TENTH, ONE_TENTH],
      transferAmount: ONE_TENTH,
      isErc20: false,
      maxFeePerGas: 1_000_000_000n,
      estimateTailGas: async () => 50_000n,
    });
    assert.equal(cover.unshieldAmountWei, ONE_TENTH * 2n);
    assert.equal(cover.withdrawalCount, 2);
    assert.equal(cover.tailGas, 50_000n);
    assert.ok(cover.paddedFee > 0n);
    assert.ok(cover.paddedFee < ONE_TENTH);
  });

  it("fails when the only note is consumed by the fee", async () => {
    await assert.rejects(
      () =>
        resolveTornadoPrivateTransferCover({
          noteAmounts: [ONE_TENTH],
          transferAmount: ONE_TENTH,
          isErc20: false,
          maxFeePerGas: 1_000_000_000n,
          estimateTailGas: async () => 50_000n,
        }),
      TornadoCoverError
    );
  });
});

describe("tornadoUnshieldOptions leftover forward", () => {
  const userTail = { to: PAYEE, data: "0x" as const, value: ONE_TENTH };

  it("allows SDK best-effort estimation only for standard unshields", () => {
    const standard = tornadoUnshieldOptions(RECIPIENT, ONE, 1_000_000_000n, PATH, 1);
    assert.equal(standard.gasEstimationPolicy, "best-effort");
    assert.equal(standard.tailCalls, undefined);
    assert.deepEqual(standard.maxGasLimits, { verificationGasLimit: 250_000n, paymasterVerificationGasLimit: 2_000_000n });
    const custom = tornadoUnshieldOptions(RECIPIENT, ONE, 1_000_000_000n, PATH, 1, [userTail], 50_000n);
    assert.equal(custom.gasEstimationPolicy, "required");
    assert.deepEqual(custom.maxGasLimits, { verificationGasLimit: 250_000n, paymasterVerificationGasLimit: 2_000_000n });
  });

  it("prepends a leftover value transfer by default", async () => {
    const options = tornadoUnshieldOptions(
      RECIPIENT,
      ONE,
      1_000_000_000n,
      PATH,
      1,
      [userTail],
      50_000n
    );
    assert.ok(options.tailCalls);
    const calls = await options.tailCalls(RECIPIENT);
    assert.equal(calls.length, 2);
    assert.equal(calls[0]!.to, RECIPIENT);
    assert.equal(calls[0]!.data, "0x");
    assert.ok(calls[0]!.value > 0n);
    assert.deepEqual(calls[1], userTail);
  });

  it("emits only the payee call when leftover forwarding is off", async () => {
    const options = tornadoUnshieldOptions(
      RECIPIENT,
      ONE,
      1_000_000_000n,
      PATH,
      1,
      [userTail],
      50_000n,
      undefined,
      false
    );
    assert.ok(options.tailCalls);
    const calls = await options.tailCalls(RECIPIENT);
    assert.deepEqual(calls, [userTail]);
  });

  it("does not bake an ERC-20 leftover transfer when leftover forwarding is off", async () => {
    const exact = encodeTornadoErc20TransferTailCall(TOKEN, PAYEE, 3_000n);
    const options = tornadoUnshieldOptions(
      RECIPIENT,
      5_000n,
      1n,
      PATH,
      1,
      [exact],
      1_000n,
      { token: TOKEN, feeReserveToken: 1_000n, bakeForward: true },
      false
    );
    assert.ok(options.tailCalls);
    const calls = await options.tailCalls(RECIPIENT);
    assert.deepEqual(calls, [exact]);
  });
});
