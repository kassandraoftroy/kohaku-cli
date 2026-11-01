import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Host } from "@kohaku-eth/plugins";
import { deriveRailgunAddress } from "kohaku-rg-js-wrapper";

import { setRailgunHostContext } from "../src/host/railgun-host-context.js";
import { makeStorage } from "../src/host/storage.js";
import {
  RailgunAdapter,
  createRailgunAdapter,
  railgunBalanceForCli,
  railgunNoteForCli,
  railgunTransferInput,
  railgunUnshieldInput,
  syncRailgunHistory,
} from "../src/lib/railgun-adapter.js";

const spendingKey = `0x${"01".repeat(32)}` as const;
const viewingKey = `0x${"02".repeat(32)}` as const;

test("Railgun v2 opens with the old file untouched and persists a reloadable checkpoint", async () => {
  const walletDir = mkdtempSync(join(tmpdir(), "kohaku-railgun-v2-"));
  const oldPath = join(walletDir, "rg-storage.json");
  const oldBytes = "legacy-file-must-remain-untouched";
  writeFileSync(oldPath, oldBytes);
  const originalFetch = globalThis.fetch;
  const originalError = console.error;
  const messages: string[] = [];
  console.error = (...args) => { messages.push(args.map(String).join(" ")); };
  globalThis.fetch = async (input, init) => {
    const request = JSON.parse(input instanceof Request ? await input.text() : String(init?.body)) as { method: string; id: number };
    assert.equal(request.method, "eth_chainId");
    const response = Response.json({ jsonrpc: "2.0", id: request.id, result: "0xaa36a7" });
    Object.defineProperty(response, "url", { value: input instanceof Request ? input.url : String(input) });
    return response;
  };

  const host = {
    keystore: { deriveAt: async (path: string) => path.startsWith("m/44'") ? spendingKey : viewingKey },
    storage: makeStorage(walletDir, "rg-v2", "test-password"),
  } as Host;
  setRailgunHostContext(host, "https://rpc.example.invalid", walletDir);
  let adapter: Awaited<ReturnType<typeof createRailgunAdapter>> | undefined;
  try {
    adapter = await createRailgunAdapter(host, 11155111n);
    assert.ok(messages.some((message) => message.includes("resyncing from chain history")));
    const calls = await adapter.prepareShield({ asset: { __type: "native" }, amount: 1_000_000_000_000_000n });
    assert.ok(Array.isArray(calls) && calls.length > 0);
    assert.equal(readFileSync(oldPath, "utf8"), oldBytes);
    await adapter.wallet.processPendingPoi();
    assert.ok(await host.storage.get("railgun-rust-checkpoint"));
    adapter.close();
    adapter = await createRailgunAdapter(host, 11155111n);
    assert.equal(adapter.wallet.syncedBlock, 0n);
    assert.equal(readFileSync(oldPath, "utf8"), oldBytes);
  } finally {
    adapter?.close();
    globalThis.fetch = originalFetch;
    console.error = originalError;
    rmSync(walletDir, { recursive: true, force: true });
  }
});

test("Railgun asset and PPOI status mapping never treats unavailable funds as spendable", () => {
  const entry = {
    asset: "erc20:0x0000000000000000000000000000000000000001",
    amount: 42n,
    poiStatus: "Unavailable" as const,
  };
  assert.deepEqual(railgunBalanceForCli(entry), {
    asset: { __type: "erc20", contract: "0x0000000000000000000000000000000000000001" },
    amount: 42n,
    tag: "Unavailable",
  });
  assert.equal(railgunBalanceForCli({ ...entry, poiStatus: null }).tag, "Unavailable");
  assert.equal(railgunNoteForCli({
    ...entry,
    treeNumber: 1,
    leafIndex: 2,
    blindedCommitment: `0x${"00".repeat(32)}`,
    commitmentType: "Shield",
    memo: "",
  }).poiStatus, "Unavailable");
  assert.throws(() => railgunBalanceForCli({ ...entry, asset: "erc721:0x0" }), /not a supported ERC-20/);
});

test("Railgun native unwrap and user tail calls reach Rust in the requested order", () => {
  const recipient = "0x0000000000000000000000000000000000000002";
  const wrapped = "0x0000000000000000000000000000000000000003";
  const spend = { accountPrivateKey: `0x${"01".repeat(32)}` as const, bundlerUrl: "https://bundler.invalid" };
  const calls = [
    { to: "0x0000000000000000000000000000000000000004" as const, value: 1n, data: "0x1234" as const },
    { to: "0x0000000000000000000000000000000000000005" as const, value: 2n, data: "0xabcd" as const },
  ];
  const native = railgunUnshieldInput(
    { asset: { __type: "native" }, amount: 10n }, recipient, calls, wrapped, spend,
  );
  assert.equal(native.token, wrapped);
  assert.equal(native.unwrapNative, true);
  assert.deepEqual(native.tailCalls, calls.map((call) => ({ target: call.to, value: call.value, data: call.data })));
  const erc20 = railgunUnshieldInput(
    { asset: { __type: "erc20", contract: "0x0000000000000000000000000000000000000006" }, amount: 10n },
    recipient, [], wrapped, spend,
  );
  assert.equal(erc20.token, "0x0000000000000000000000000000000000000006");
  assert.equal(erc20.unwrapNative, false);
});

test("Railgun private recipient uses internal transfer preparation without an unshield", async () => {
  const recipient = deriveRailgunAddress(spendingKey, viewingKey, 1n);
  assert.match(recipient, /^0zk1/);
  const wrapped = "0x0000000000000000000000000000000000000003";
  const spend = { accountPrivateKey: `0x${"01".repeat(32)}` as const, bundlerUrl: "https://bundler.invalid" };
  const asset = { asset: { __type: "native" as const }, amount: 10n };
  const input = railgunTransferInput(asset, recipient, wrapped, spend);
  assert.deepEqual(input, { recipient, token: wrapped, amount: 10n, ...spend });
  assert.equal("unwrapNative" in input, false);
  assert.equal("tailCalls" in input, false);

  let calls = 0;
  const prepared = { userOpHash: "0x1234", signed: { userOp: {}, entryPoint: wrapped } };
  const adapter = Object.create(RailgunAdapter.prototype) as RailgunAdapter;
  Object.assign(adapter, { wallet: {
    chain: { wrappedBaseToken: wrapped },
    prepareTransfer: async (options: unknown) => { calls++; assert.deepEqual(options, input); return prepared; },
    prepareUnshield: () => { throw new Error("unshield must not run"); },
  } });
  adapter.configureSpend(spend.accountPrivateKey, spend.bundlerUrl);
  assert.equal(await adapter.prepareTransfer(asset, recipient), prepared);
  assert.equal(calls, 1);
});

test("Railgun resync checkpoints bounded windows and stops when the source lags", async () => {
  let syncedBlock = 0n;
  const targets: bigint[] = [];
  const wallet = {
    chain: { deploymentBlock: 100n },
    get syncedBlock() { return syncedBlock; },
    syncTo: async (target: bigint) => {
      targets.push(target);
      syncedBlock = target;
    },
    sync: async () => { throw new Error("unexpected full sync"); },
  };
  assert.equal(await syncRailgunHistory(wallet, 250_099n), true);
  assert.deepEqual(targets, [5_099n, 25_099n, 55_099n, 100_099n, 200_099n, 250_099n]);

  syncedBlock = 25_099n;
  targets.length = 0;
  assert.equal(await syncRailgunHistory(wallet, 250_099n), true);
  assert.deepEqual(targets, [55_099n, 100_099n, 200_099n, 250_099n]);

  syncedBlock = 0n;
  targets.length = 0;
  wallet.syncTo = async (target) => {
    targets.push(target);
    syncedBlock = 200n;
  };
  assert.equal(await syncRailgunHistory(wallet, 250_099n), false);
  assert.deepEqual(targets, [5_099n]);
});
