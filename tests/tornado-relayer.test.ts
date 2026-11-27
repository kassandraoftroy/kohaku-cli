import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Host } from "@kohaku-eth/plugins";
import { TornadoInstances } from "@kohaku-eth/tornado-cash";
import { encodeAbiParameters, encodeEventTopics, parseAbi, toHex } from "viem";
import { runWithActivityLog, readActivity } from "../src/utils/activity-log.js";
import {
  broadcastClassicTornadoRelayerUnshield, classicTornadoRelayerPool,
  prepareClassicTornadoRelayerUnshield, resolveTornadoExitMode,
  validateClassicTornadoRelayerOperation,
} from "../src/utils/tornado-relayer.js";

const recipient = "0x1111111111111111111111111111111111111111";
const rewardAccount = "0x2222222222222222222222222222222222222222";
const nullifier = toHex(3n, { size: 32 });
const txHash = toHex(4n, { size: 32 });
const chainId = 1n;
const eth = { isEth: true, tokenAddress: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" };
const amount = 10n ** 17n;
const pool = classicTornadoRelayerPool(chainId, amount, eth);
const fee = amount / 100n;
const relayerUrl = "https://relayer.example";
const proofArgs = [toHex(1n, { size: 32 }), nullifier, recipient, rewardAccount, toHex(fee), "0x0"] as const;
function operation() {
  return { withdrawals: [{ mode: "relayer", poolAddress: pool.address as bigint, relayerUrl, fee, denomination: amount,
    proof: { proof: `0x${"11".repeat(256)}`, args: [...proofArgs] } }] };
}
function quote() {
  return validateClassicTornadoRelayerOperation({ operation: operation(), chainId, amount, recipient, token: eth });
}
function receipt(overrides: Record<string, unknown> = {}) {
  return { transactionHash: txHash, status: "success", logs: [{
    address: toHex(pool.address, { size: 20 }),
    topics: encodeEventTopics({ abi: parseAbi(["event Withdrawal(address to, bytes32 nullifierHash, address indexed relayer, uint256 fee)"]),
      eventName: "Withdrawal", args: { relayer: rewardAccount } }),
    data: encodeAbiParameters([{ type: "address" }, { type: "bytes32" }, { type: "uint256" }], [recipient, nullifier, fee]),
  }], ...overrides };
}

test("relayer exit option is explicit, Tornado-only, one-note, and never a private-transfer fallback", () => {
  assert.equal(resolveTornadoExitMode({ protocol: "tornado" }), "paymaster");
  assert.equal(resolveTornadoExitMode({ protocol: "tornado", exitMode: "relayer" }), "relayer");
  assert.throws(() => resolveTornadoExitMode({ protocol: "tornado", exitMode: "other" }), /paymaster or relayer/);
  assert.throws(() => resolveTornadoExitMode({ protocol: "privacy-pools", exitMode: "relayer" }), /only supported.*tornado/);
  assert.throws(() => resolveTornadoExitMode({ protocol: "tornado", exitMode: "relayer", privateTransfer: true }), /only supported by unshield/);
  assert.throws(() => resolveTornadoExitMode({ protocol: "tornado", exitMode: "relayer", tailCalls: "" }), /do not support --tail-calls/);
  assert.throws(() => resolveTornadoExitMode({ protocol: "tornado", exitMode: "relayer", amountMax: true }), /explicit pool denomination/);
});

test("classic relayer catalog accepts original ETH/ERC20 pools independently of paymaster support", () => {
  assert.equal(classicTornadoRelayerPool(chainId, amount, eth).address, pool.address);
  const cdai = TornadoInstances[1].find(pool => pool.symbol === "cDAI")!;
  assert.equal(classicTornadoRelayerPool(chainId, cdai.denomination,
    { isEth: false, tokenAddress: toHex(cdai.asset, { size: 20 }) }).address, cdai.address);
  for (const amount of [0n, -1n, 10n ** 16n, 3n * 10n ** 17n, 2n * 10n ** 17n]) {
    assert.throws(() => classicTornadoRelayerPool(chainId, amount, eth), /original Tornado pool denomination/);
  }
  assert.throws(() => classicTornadoRelayerPool(11155111n, 10n ** 19n, eth), /original Tornado pool denomination/);
});

test("relayer preparation requires one note and passes only relayer options to the SDK", async () => {
  let prepared = 0;
  const plugin = { notes: async () => [{ pool: pool.address, amount, balance: amount }],
    prepareUnshield: async (_asset: unknown, to: unknown, options: unknown) => {
      assert.equal(to, recipient); assert.deepEqual(options, { mode: "relayer" }); prepared++; return operation();
    } } as never;
  const preparedQuote = await prepareClassicTornadoRelayerUnshield({ plugin, chainId,
    asset: { asset: { __type: "erc20", contract: eth.tokenAddress }, amount } as never, recipient, token: eth });
  assert.equal(prepared, 1);
  assert.equal(preparedQuote.net, amount - fee);
  const smallPool = classicTornadoRelayerPool(chainId, 10n ** 17n, eth);
  const onlySmallNotes = { notes: async () => Array.from({ length: 10 }, () => ({
    pool: smallPool.address, amount: 10n ** 17n, balance: 10n ** 17n,
  })), prepareUnshield: async () => assert.fail("Must reject before proof preparation") } as never;
  await assert.rejects(prepareClassicTornadoRelayerUnshield({ plugin: onlySmallNotes, chainId,
    asset: { asset: { __type: "erc20", contract: eth.tokenAddress }, amount: 10n ** 18n } as never,
    recipient, token: eth }), /exactly one unspent/);
});

test("relayer proof validation rejects changed payout, refund, pool, fee, endpoint and extra withdrawals", () => {
  const invalid = [
    (op: ReturnType<typeof operation>) => { op.withdrawals[0]!.proof.args[2] = rewardAccount; },
    (op: ReturnType<typeof operation>) => { op.withdrawals[0]!.proof.args[5] = "0x1"; },
    (op: ReturnType<typeof operation>) => { op.withdrawals[0]!.poolAddress = 1n; },
    (op: ReturnType<typeof operation>) => { op.withdrawals[0]!.fee = amount; },
    (op: ReturnType<typeof operation>) => { op.withdrawals[0]!.fee += 1n; },
    (op: ReturnType<typeof operation>) => { op.withdrawals[0]!.relayerUrl = "https://user:secret@relayer.example/"; },
    (op: ReturnType<typeof operation>) => { op.withdrawals[0]!.relayerUrl = "https://localhost/"; },
    (op: ReturnType<typeof operation>) => { op.withdrawals.push(op.withdrawals[0]!); },
  ];
  for (const change of invalid) {
    const op = operation(); change(op);
    assert.throws(() => validateClassicTornadoRelayerOperation({ operation: op, chainId, amount, recipient, token: eth }));
  }
});

test("relayer acknowledgement waits for a matching receipt and records encrypted job metadata", async () => {
  const walletDir = mkdtempSync(join(tmpdir(), "kohaku-relayer-"));
  const calls: Array<{ url: string; method: string }> = [];
  try {
    await runWithActivityLog({ walletDir, password: "pw", chainId, operation: "unshield", protocol: "tornado" }, async () => {
      const result = await broadcastClassicTornadoRelayerUnshield({ quote: quote(), timeoutMs: 0,
        host: { network: { fetch: async (url: string, init: RequestInit) => {
          calls.push({ url, method: init?.method ?? "GET" });
          assert.equal(init.redirect, "error");
          if (init.method === "POST") {
            assert.equal(readActivity(walletDir, "pw")[0]!.status, "submitted");
            assert.equal(JSON.parse(String(init.body)).contract, toHex(pool.address, { size: 20 }));
            return Response.json({ id: "job_123" });
          }
          assert.equal(readActivity(walletDir, "pw")[0]!.relayerJobId, "job_123");
          assert.equal(readActivity(walletDir, "pw")[0]!.status, "submitted");
          return Response.json({ txHash, status: "CONFIRMED" });
        } } } as unknown as Host,
        client: { getTransactionReceipt: async () => receipt() } as never,
      });
      assert.equal(result.txHash, txHash);
      const [entry] = readActivity(walletDir, "pw");
      assert.equal(entry!.status, "confirmed");
      assert.equal(entry!.relayerUrl, relayerUrl);
      assert.equal(entry!.nullifierHash, nullifier);
      assert.equal(entry!.txHash, txHash);
    });
    assert.deepEqual(calls.map(call => call.method), ["POST", "GET"]);
  } finally { rmSync(walletDir, { recursive: true, force: true }); }
});

for (const outcome of ["lost-send", "invalid-id", "pending", "wrong-event", "reverted", "failed-job", "hostile-error"] as const) {
  test(`relayer ${outcome} remains unconfirmed without retries or accepting a job as mining`, async () => {
    const walletDir = mkdtempSync(join(tmpdir(), "kohaku-relayer-unknown-"));
    let sends = 0;
    try {
      await runWithActivityLog({ walletDir, password: "pw", chainId, operation: "unshield", protocol: "tornado" }, async () => {
        await assert.rejects(broadcastClassicTornadoRelayerUnshield({ quote: quote(), timeoutMs: 0,
          host: { network: { fetch: async (_url: string, init: RequestInit) => {
            if (init.method === "POST") {
              sends++;
              if (outcome === "lost-send") throw new Error("network unavailable");
              if (outcome === "hostile-error") return Response.json({ error: "PRIVATE_PROOF_ECHO" }, { status: 400 });
              return Response.json({ id: outcome === "invalid-id" ? "../../other" : "job_123" });
            }
            return Response.json(outcome === "pending" ? { status: "QUEUED" } : outcome === "failed-job" ? { status: "FAILED" } : { txHash });
          } } } as unknown as Host,
          client: { getTransactionReceipt: async () => receipt(outcome === "wrong-event" ? { logs: [] } : outcome === "reverted" ? { status: "reverted" } : {}) } as never,
        }), (error: unknown) => {
          assert.match((error as Error).message, /unconfirmed and may still land/);
          assert.doesNotMatch((error as Error).message, /PRIVATE_PROOF_ECHO/);
          return true;
        });
        const [entry] = readActivity(walletDir, "pw");
        assert.equal(entry!.status, "submitted");
        assert.equal(entry!.relayerUrl, relayerUrl);
        if (outcome !== "lost-send" && outcome !== "invalid-id" && outcome !== "hostile-error") assert.equal(entry!.relayerJobId, "job_123");
      });
      assert.equal(sends, 1);
    } finally { rmSync(walletDir, { recursive: true, force: true }); }
  });
}

test("relayer proof does not leave the host if initial encrypted tracking cannot be saved", async () => {
  const walletDir = mkdtempSync(join(tmpdir(), "kohaku-relayer-disk-failure-"));
  try {
    writeFileSync(join(walletDir, "activity"), "blocks the activity directory");
    await runWithActivityLog({ walletDir, password: "pw", chainId, operation: "unshield", protocol: "tornado" }, async () => {
      await assert.rejects(broadcastClassicTornadoRelayerUnshield({ quote: quote(), timeoutMs: 0,
        host: { network: { fetch: async () => assert.fail("No proof may be sent without a durable attempt record") } } as unknown as Host,
        client: {} as never,
      }), /Cannot save encrypted submission metadata/);
    });
  } finally { rmSync(walletDir, { recursive: true, force: true }); }
});
