import assert from "node:assert/strict";
import { test } from "node:test";
import { TornadoPaymasterConfigs } from "@kohaku-eth/tornado-cash";
import {
  assertTornadoUnshieldPoolsDeployed,
  selectTornadoWithdrawalNotes,
  tornadoSelectedPaymasterPools,
} from "../src/utils/tornado-unshield-pools.js";
import { tornadoPoolsForChain } from "../src/utils/tornado-pools.js";
import { prepareProtocolUnshield } from "../src/lib/privacy-pools-unshield.js";

const catalog = tornadoPoolsForChain(1n).filter((pool) => !pool.isERC20);
const note = (denomination: bigint, balance = denomination) => ({
  pool: BigInt(catalog.find((pool) => pool.denomination === denomination)!.poolAddress),
  amount: denomination,
  balance,
});
const eth = 10n ** 18n;
const one = note(eth);
const tenth = note(eth / 10n);
const threeTenths = note(3n * eth / 10n);
const hundredth = note(eth / 100n);

function client(options: { paymasterCode?: string; adapterCode?: string; approved?: boolean } = {}) {
  return {
    getCode: async ({ address }: { address: string }) =>
      address.toLowerCase() === TornadoPaymasterConfigs[1].paymasterAddress.toLowerCase()
        ? options.paymasterCode ?? "0x1234"
        : options.adapterCode ?? "0x1234",
    readContract: async () => options.approved ?? true,
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

test("a classic withdrawal succeeds even when the wallet also holds unsupported new-pool notes", async () => {
  assert.equal(tornadoSelectedPaymasterPools(1n, [hundredth, threeTenths, one], eth).length, 1);
  await assertTornadoUnshieldPoolsDeployed({ client: client(), chainId: 1n, notes: [hundredth, one], amount: eth });
});

test("a selected unsupported pool fails clearly before any RPC request", async () => {
  await assert.rejects(assertTornadoUnshieldPoolsDeployed({
    client: { getCode: async () => { assert.fail("Must not query RPC when configuration is missing"); } } as never,
    chainId: 1n, notes: [hundredth], amount: eth / 100n,
  }), /0\.01 ETH.*no paymaster FeeAdapter configured.*--exclude-new-pools/);
});

test("batch checks include unsupported execution-phase pools, not just its first note", () => {
  assert.throws(() => tornadoSelectedPaymasterPools(1n, [one, threeTenths], 13n * eth / 10n), /0\.3 ETH.*no paymaster FeeAdapter/);
  assert.throws(() => tornadoSelectedPaymasterPools(1n, [one, hundredth], 101n * eth / 100n), /no paymaster FeeAdapter/);
});

test("future SDK adapter mappings enable the new denominations without a new exclusion rule", () => {
  const map = {
    ...TornadoPaymasterConfigs[1].poolsAccountsMap,
    [`0x${threeTenths.pool.toString(16).padStart(40, "0")}`]: "0x0000000000000000000000000000000000000001",
  };
  assert.equal(tornadoSelectedPaymasterPools(1n, [one, threeTenths], 13n * eth / 10n, map).length, 2);
});

test("missing paymaster code, missing adapter code, and unapproved adapters each fail before proving", async () => {
  for (const [options, message] of [
    [{ paymasterCode: "0x" }, /paymaster .*not deployed/],
    [{ adapterCode: "0x" }, /no deployed paymaster FeeAdapter/],
    [{ approved: false }, /not approved by paymaster/],
  ] as const) {
    await assert.rejects(assertTornadoUnshieldPoolsDeployed({
      client: client(options), chainId: 1n, notes: [one], amount: eth,
    }), message);
  }
});

test("central prepare rejects unsupported pools without calling SDK prepareUnshield", async () => {
  let prepared = false;
  await assert.rejects(prepareProtocolUnshield({
    protocol: "tornado", chainId: 1n, rpcUrl: "unused", client: client(),
    plugin: {
      notes: async () => [hundredth],
      prepareUnshield: async () => { prepared = true; },
    } as never,
    tokenMeta: { isEth: true, tokenAddress: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", symbol: "ETH", decimals: 18 },
    amountWei: eth / 100n, recipient: "0x0000000000000000000000000000000000000001", tailCalls: [],
  }), /no paymaster FeeAdapter/);
  assert.equal(prepared, false);
});
