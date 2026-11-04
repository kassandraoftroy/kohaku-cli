import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AssetAmount } from "@kohaku-eth/plugins";
import { privateKeyToAccount } from "viem/accounts";

import { prepareEthMaxTransfer } from "../src/utils/transfer-max.js";
import { sendTransactionAndWait } from "../src/utils/viem-tx.js";
import { resolveTransactionSender, validateSenderPrivateKey } from "../src/lib/transaction-sender.js";
import { RailgunAdapter } from "../src/lib/railgun-adapter.js";
import { preparePrivacyPoolsUnshield } from "../src/lib/privacy-pools-unshield.js";
import { privateTransferBalanceSummary } from "../src/lib/private-transfer-balance.js";
import { tornadoPrivateTransferMaxAmount, resolveTornadoPrivateTransferCover } from "../src/lib/private-transfer.js";
import { wethAddressForChain, type ResolvedTokenMeta } from "../src/utils/tokens-util.js";

const KEY = `0x${"01".repeat(32)}` as const;
const ADDRESS = privateKeyToAccount(KEY).address;
const OTHER = "0x2222222222222222222222222222222222222222";
const ETH = { isEth: true, tokenAddress: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", symbol: "ETH", decimals: 18 } as ResolvedTokenMeta;

test("max ETH preparation pins a fee budget that fits the balance, including contract gas", async () => {
  for (const estimatedGas of [21_000n, 90_000n]) {
    const balance = 31_000_000_000_000_000n;
    const client = {
      getBalance: async () => balance,
      getBlock: async () => ({ baseFeePerGas: 100_000_000n }),
      estimateFeesPerGas: async () => ({ maxFeePerGas: 160_003_331n, maxPriorityFeePerGas: 22n }),
      estimateGas: async () => estimatedGas,
    };
    const tx = await prepareEthMaxTransfer(client as never, ADDRESS, OTHER);
    assert.equal(tx.value + tx.gas * tx.maxFeePerGas, balance);
    assert.ok(tx.gas >= estimatedGas);
    assert.equal(BigInt(tx.preview.estimatedMax), tx.gas * tx.maxFeePerGas);
    let signed: Record<string, unknown> | undefined;
    await sendTransactionAndWait({ account: { address: ADDRESS }, chain: {},
      sendTransaction: async (args: Record<string, unknown>) => { signed = args; return `0x${"ab".repeat(32)}`; },
    } as never, { waitForTransactionReceipt: async () => ({ status: "success" }) } as never, { to: OTHER, ...tx });
    assert.equal(signed?.maxFeePerGas, tx.maxFeePerGas);
    assert.equal(signed?.gas, tx.gas);
    assert.equal(signed?.value, tx.value);
  }
});

test("max ETH fails before signing when fees exceed the balance", async () => {
  await assert.rejects(prepareEthMaxTransfer({ getBalance: async () => 10n,
    getBlock: async () => ({ baseFeePerGas: 1n }), estimateFeesPerGas: async () => ({ maxFeePerGas: 1n }),
    estimateGas: async () => 21_000n,
  } as never, ADDRESS, OTHER), /Insufficient ETH/);
});

test("external sender keys match the selected address and never save an account", async () => {
  const walletDir = mkdtempSync(join(tmpdir(), "kohaku-sender-key-"));
  const opts = { fromValue: ADDRESS, walletDir, mnemonic: "test test test test test test test test test test test junk", password: "test", nonInteractive: true };
  try {
    const before = readdirSync(walletDir);
    assert.equal(validateSenderPrivateKey(KEY.slice(2), ADDRESS), KEY);
    assert.throws(() => validateSenderPrivateKey(KEY, OTHER), /does not match/);
    assert.throws(() => validateSenderPrivateKey("secret-invalid-value", ADDRESS), /Invalid sender private key/);
    assert.throws(() => validateSenderPrivateKey(`0x${"00".repeat(32)}`, ADDRESS), /Invalid sender private key/);
    assert.equal((await resolveTransactionSender({ ...opts, dryRun: false, senderPriv: KEY })).senderPrivateKey, KEY);
    await assert.rejects(resolveTransactionSender({ ...opts, dryRun: false }), /--sender-priv/);
    assert.equal((await resolveTransactionSender({ ...opts, dryRun: true })).senderPrivateKey, undefined);
    assert.ok((await resolveTransactionSender({ ...opts, fromValue: "42", dryRun: false })).senderPrivateKey);
    assert.deepEqual(readdirSync(walletDir), before);
  } finally { rmSync(walletDir, { recursive: true, force: true }); }
});

test("Railgun POI outage preserves history balances, invalidates spendability, and recovers", async () => {
  const adapter = Object.create(RailgunAdapter.prototype) as RailgunAdapter;
  let outage = true;
  let historyFailure = false;
  Object.assign(adapter, { rpcUrl: "https://rpc.invalid", lastSyncedAt: 0, wallet: {
    syncedBlock: 10n, chain: { deploymentBlock: 1n },
    syncHistoryTo: async () => { if (historyFailure) throw new Error("history failure"); },
    refreshPoi: async () => { if (outage) throw new Error("Txid indexer unavailable"); },
    pendingPoi: () => [],
    balances: async () => [{ asset: `erc20:${wethAddressForChain(1n)}`, amount: 123n, poiStatus: "Valid" }],
    notes: async () => [],
  } });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ result: historyFailure ? "0xb" : "0xa" });
  try {
    await adapter.sync();
    assert.match(adapter.poiError!, /Txid indexer/);
    assert.equal((await adapter.balance())[0]!.amount, 123n);
    assert.equal((await adapter.balance())[0]!.tag, "Unavailable");
    await assert.rejects(adapter.prepareTransfer({ asset: { __type: "native" }, amount: 1n }, "0zk123"), /POI data missing/);
    outage = false;
    await adapter.sync();
    assert.equal(adapter.poiError, undefined);
    assert.equal((await adapter.balance())[0]!.tag, "Valid");
    historyFailure = true;
    await assert.rejects(adapter.sync(), /history failure/);
  } finally { globalThis.fetch = originalFetch; }
});

test("Privacy Pools max spends approved gross directly despite a higher final SDK fee", async () => {
  for (const balances of [[1_000n], [700n, 300n]]) {
    let calls = 0;
    const total = balances.reduce((sum, value) => sum + value, 0n);
    const operation = await preparePrivacyPoolsUnshield({ plugin: {
      notes: async () => [...balances.map((balance) => ({ balance, approved: true, assetAddress: BigInt(ETH.tokenAddress) })),
        { balance: 50_000n, approved: false, assetAddress: BigInt(ETH.tokenAddress) }],
      prepareUnshield: async (asset: AssetAmount, _to: string, options: { exact?: unknown }) => {
        calls++;
        assert.equal(asset.amount, total);
        assert.equal(options.exact, undefined);
        return { withdrawal: { fee: 199n, withdrawnValue: total } };
      },
    } as never, chainId: 1n, rpcUrl: "https://rpc.invalid", tokenMeta: ETH,
      amountWei: 900n, amountMax: true, recipient: ADDRESS, tailCalls: [],
      recipientDerivationPath: "m/44'/60'/0'/0/0",
    }) as { exact: { expectedNet: bigint; fee: bigint } };
    assert.equal(calls, 1);
    assert.equal(operation.exact.expectedNet, total - 199n);
  }
});

test("private transfer balance summary distinguishes total, spendable and fee WETH across protocols", () => {
  for (const protocol of ["railgun", "privacy-pools", "tornado"] as const) {
    const token = protocol === "railgun" ? wethAddressForChain(1n)! : ETH.tokenAddress;
    const rows = [{ asset: { __type: "erc20", contract: token }, amount: 50n, tag: "Valid" },
      { asset: { __type: "erc20", contract: token }, amount: 20n, tag: "Unavailable" }] as AssetAmount[];
    const summary = privateTransferBalanceSummary(rows, ETH, 1n, protocol);
    assert.equal(summary.total, 70n);
    assert.equal(summary.spendable, 50n);
    assert.equal(summary.feeToken, protocol === "railgun" ? 50n : 0n);
  }
});

test("Tornado max reserves fees for the selected note count and remains coverable", async () => {
  for (const isErc20 of [false, true]) {
    const noteAmounts = [10n ** 17n, 10n ** 17n];
    const opts = { noteAmounts, isErc20, maxFeePerGas: 10n ** 9n,
      quoteFeeWei: isErc20 ? async (fee: bigint) => fee * 2n : undefined };
    const max = await tornadoPrivateTransferMaxAmount(opts);
    const cover = await resolveTornadoPrivateTransferCover({ ...opts, transferAmount: max, estimateTailGas: async () => undefined });
    assert.ok(max > 0n);
    assert.ok(max + cover.paddedFee <= cover.unshieldAmountWei);
    assert.equal(cover.unshieldAmountWei, 2n * 10n ** 17n);
  }
});
