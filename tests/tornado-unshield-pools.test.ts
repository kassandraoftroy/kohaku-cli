import assert from "node:assert/strict";
import { test } from "node:test";
import { TornadoPaymasterConfigs } from "@kohaku-eth/tornado-cash";
import {
  assertTornadoUnshieldPoolsDeployed,
  selectTornadoWithdrawalNotes,
  tornadoSelectedPaymasterPools,
} from "../src/utils/tornado-unshield-pools.js";
import { tornadoPaymasterPoolsForAsset, tornadoPoolsForChain } from "../src/utils/tornado-pools.js";
import { prepareProtocolUnshield } from "../src/lib/privacy-pools-unshield.js";
import { tornadoPaymasterAddress } from "../src/utils/tornado-paymaster-quote.js";
import { tornadoPaymasterConfig } from "../src/utils/plugins.js";

const eth = 10n ** 18n;
function note(denomination: bigint, balance = denomination, chainId = 1n) {
  const pool = tornadoPoolsForChain(chainId).find((pool) => !pool.isERC20 && pool.denomination === denomination)!;
  return { pool: BigInt(pool.poolAddress), amount: denomination, balance };
}
const one = note(eth);
const tenth = note(eth / 10n);
const threeTenths = note(3n * eth / 10n);
const hundredth = note(eth / 100n);
const unknown = { pool: 0xdeadn, amount: eth / 100n, balance: eth / 100n };

function client(options: { paymasterCode?: string; allowed?: boolean; check?: (request: any) => void } = {}) {
  return {
    getCode: async () => options.paymasterCode ?? "0x1234",
    readContract: async (request: unknown) => {
      options.check?.(request);
      return [options.allowed ?? true, "0x0000000000000000000000000000000000000000"];
    },
  } as never;
}

test("selection matches largest-first exact packing and ignores spent or oversized notes", () => {
  const notes = [hundredth, tenth, threeTenths, one, note(10n * eth), note(eth, 0n)];
  assert.deepEqual(selectTornadoWithdrawalNotes(notes, 14n * eth / 10n), [one, threeTenths, tenth]);
  assert.deepEqual(selectTornadoWithdrawalNotes(notes, eth), [one]);
  assert.deepEqual(selectTornadoWithdrawalNotes(notes, eth / 100n), [hundredth]);
  assert.equal(notes[0], hundredth);
  assert.throws(() => selectTornadoWithdrawalNotes([one], eth / 10n), /compose/);
});

for (const chainId of [1, 11155111] as const) {
  test(`all classic and extended pools use the direct paymaster on chain ${chainId}`, async () => {
    const config = TornadoPaymasterConfigs[chainId];
    const pools = tornadoPoolsForChain(BigInt(chainId));
    assert.equal(tornadoPaymasterPoolsForAsset(BigInt(chainId), { isEth: true }).length,
      pools.filter((pool) => !pool.isERC20).length);
    const pluginConfig = tornadoPaymasterConfig(BigInt(chainId)) as Record<number, typeof config>;
    assert.equal(pluginConfig[chainId].paymasterAddress, config.paymasterAddress);
    assert.equal(tornadoPaymasterAddress(BigInt(chainId)), config.paymasterAddress);
    for (const pool of pools) {
      const poolNote = { pool: BigInt(pool.poolAddress), amount: pool.denomination, balance: pool.denomination };
      assert.deepEqual(tornadoSelectedPaymasterPools(BigInt(chainId), [poolNote], pool.denomination), [pool.poolAddress]);
      await assertTornadoUnshieldPoolsDeployed({
        client: client({ check: (request) => {
          assert.equal(request.address.toLowerCase(), config.paymasterAddress.toLowerCase());
          assert.equal(request.functionName, "instances");
          assert.deepEqual(request.args, [pool.poolAddress]);
        } }),
        chainId: BigInt(chainId), notes: [poolNote], amount: pool.denomination,
      });
    }
    const classic = tornadoPaymasterPoolsForAsset(BigInt(chainId), { isEth: true, excludeNewPools: true });
    assert.ok(classic.every((pool) => !pool.isNew));
    assert.equal(classic.length, chainId === 1 ? 4 : 2);
  });

  test(`mixed-denomination batch checks every pool on chain ${chainId}`, async () => {
    const notes = [note(eth, eth, BigInt(chainId)), note(3n * eth / 10n, 3n * eth / 10n, BigInt(chainId)), note(eth / 100n, eth / 100n, BigInt(chainId))];
    const checked: string[] = [];
    await assertTornadoUnshieldPoolsDeployed({
      client: client({ check: (request) => { checked.push(request.args[0]); } }),
      chainId: BigInt(chainId), notes, amount: 131n * eth / 100n,
    });
    assert.equal(checked.length, 3);
  });
}

test("unsupported execution-phase pools fail before any RPC requests", async () => {
  await assert.rejects(assertTornadoUnshieldPoolsDeployed({
    client: { getCode: async () => { assert.fail("Must not query RPC with missing pool support"); } } as never,
    chainId: 1n, notes: [one, unknown], amount: 101n * eth / 100n,
  }), /no paymaster support configured/);
  assert.throws(() => tornadoSelectedPaymasterPools(1n, [hundredth], eth / 100n, []), /0\.01 ETH.*--exclude-new-pools/);
});

test("holding an unsupported note does not block a withdrawal that selects only supported pools", async () => {
  await assertTornadoUnshieldPoolsDeployed({ client: client(), chainId: 1n, notes: [unknown, one], amount: eth });
});

test("missing paymaster code and disabled instances fail before proving", async () => {
  await assert.rejects(assertTornadoUnshieldPoolsDeployed({
    client: client({ paymasterCode: "0x" }), chainId: 1n, notes: [one], amount: eth,
  }), /paymaster .*not deployed/);
  await assert.rejects(assertTornadoUnshieldPoolsDeployed({
    client: client({ allowed: false }), chainId: 1n, notes: [hundredth], amount: eth / 100n,
  }), /not allowlisted by paymaster/);
});

test("central prepare accepts new denominations and delegates proof construction to the SDK", async () => {
  for (const chainId of [1n, 11155111n]) {
    let prepared = false;
    const poolNote = note(eth / 100n, eth / 100n, chainId);
    const result = await prepareProtocolUnshield({
      protocol: "tornado", chainId, rpcUrl: "unused", client: client(),
      plugin: {
        notes: async () => [poolNote],
        prepareUnshield: async (_asset: unknown, _recipient: unknown, options: { mode: string }) => {
          prepared = true;
          assert.equal(options.mode, "paymaster");
          return "prepared";
        },
      } as never,
      tokenMeta: { isEth: true, tokenAddress: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", symbol: "ETH", decimals: 18 },
      amountWei: eth / 100n, recipient: "0x0000000000000000000000000000000000000001", tailCalls: [],
      tornadoMaxFeePerGas: 1n, tornadoWithdrawalCount: 1,
    });
    assert.equal(prepared, true);
    assert.equal(result, "prepared");
  }
});
