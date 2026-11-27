import assert from "node:assert/strict";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPublicClient, custom, keccak256, parseTransaction, type Hex } from "viem";
import { sepolia } from "viem/chains";
import { withFakeTor } from "./helpers/fake-tor.js";
import { kohakuPrivateFetch, withTor } from "../src/utils/tor.js";
import { readActivity, runWithActivityLog } from "../src/utils/activity-log.js";
import { readNetworkTrafficLog, runWithTrafficLogWallet } from "../src/utils/network-traffic-log.js";
import { makeWalletClient, sendTransactionAndWait } from "../src/utils/viem-tx.js";
import { DEFAULT_SUBMIT_RPC_URLS, resolveSubmitRpcUrl, submitSignedTransaction, TransactionSubmissionError } from "../src/utils/transaction-submission.js";

type Rpc = { jsonrpc: string; id: number; method: string; params: unknown[] };
const raw = "0x02deadbeef" as Hex;
const hash = keccak256(raw);
const key = `0x${"01".repeat(32)}` as Hex;
const recipient = `0x${"22".repeat(20)}` as Hex;
const originalFetch = globalThis.fetch;
let clearRequests: string[] = [];
let clearFetch: typeof fetch = async () => { throw new Error("Unexpected clearnet request"); };
// withTor keeps its installed fetch patch. A stable captured proxy lets tests
// inspect clearnet opt-outs without restoring or replacing production globals.
globalThis.fetch = ((input, init) => clearFetch(input, init)) as typeof fetch;
const previousEnv = { submit: process.env.KOHAKU_SUBMIT_RPC_URL, without: process.env.KOHAKU_WITHOUT_TOR };

function response(request: Rpc, result: unknown) {
  return Response.json({ jsonrpc: "2.0", id: request.id, result });
}

function successfulRpc(request: Rpc) {
  return response(request, request.method === "eth_chainId" ? "0xaa36a7" : keccak256(request.params[0] as Hex));
}

beforeEach(() => {
  delete process.env.KOHAKU_SUBMIT_RPC_URL;
  delete process.env.KOHAKU_WITHOUT_TOR;
  clearRequests = [];
  clearFetch = async (input) => { clearRequests.push(String(input)); throw new Error("Unexpected clearnet request"); };
});
afterEach(() => {
  if (previousEnv.submit === undefined) delete process.env.KOHAKU_SUBMIT_RPC_URL;
  else process.env.KOHAKU_SUBMIT_RPC_URL = previousEnv.submit;
  if (previousEnv.without === undefined) delete process.env.KOHAKU_WITHOUT_TOR;
  else process.env.KOHAKU_WITHOUT_TOR = previousEnv.without;
});
after(() => { globalThis.fetch = originalFetch; });

describe("transaction submission endpoints", () => {
  it("uses separate chain defaults and an explicit override for other chains", () => {
    assert.equal(resolveSubmitRpcUrl(1n), DEFAULT_SUBMIT_RPC_URLS["1"] + "/");
    assert.equal(resolveSubmitRpcUrl(11155111n), DEFAULT_SUBMIT_RPC_URLS["11155111"] + "/");
    assert.throws(() => resolveSubmitRpcUrl(31337n), /KOHAKU_SUBMIT_RPC_URL/);
    process.env.KOHAKU_SUBMIT_RPC_URL = "https://submit.invalid/rpc/key";
    assert.equal(resolveSubmitRpcUrl(31337n), "https://submit.invalid/rpc/key");
  });

  it("rejects insecure remote endpoints and URL credentials without echoing them", () => {
    for (const url of ["http://remote.invalid", "https://secret:password@submit.invalid", "ftp://submit.invalid", "https://submit.invalid/#key", "invalid"]) {
      process.env.KOHAKU_SUBMIT_RPC_URL = url;
      assert.throws(() => resolveSubmitRpcUrl(1n), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.doesNotMatch(error.message, /password|remote\.invalid|#key/);
        return true;
      });
    }
    for (const url of ["http://localhost:8545", "http://submit.onion/rpc"]) {
      process.env.KOHAKU_SUBMIT_RPC_URL = url;
      assert.ok(resolveSubmitRpcUrl(1n));
    }
  });
});

it("private fetch bypasses the read-RPC hostname exemption and records Tor routing", async () => {
  const walletDir = mkdtempSync(join(tmpdir(), "kohaku-private-fetch-"));
  const seen: string[] = [];
  try {
    await withFakeTor(async (url) => { seen.push(url); return Response.json({ ok: true }); }, () =>
      runWithTrafficLogWallet(walletDir, () => withTor(true, { rpcUrl: "https://read.invalid/rpc" }, async () => {
        const result = await kohakuPrivateFetch("https://read.invalid/ccip");
        assert.deepEqual(await result.json(), { ok: true });
      })));
    assert.deepEqual(seen, ["https://read.invalid/ccip"]);
    assert.deepEqual(clearRequests, []);
    assert.equal(readNetworkTrafficLog(walletDir).at(-1)!.via, "tor");
  } finally { rmSync(walletDir, { recursive: true, force: true }); }
});

it("submits locally signed transactions only through the Tor submit endpoint and keeps read/receipt routing", async () => {
  const walletDir = mkdtempSync(join(tmpdir(), "kohaku-submit-"));
  const reads: string[] = [];
  const sends: Rpc[] = [];
  let receiptHash: string | undefined;
  const publicClient = createPublicClient({ chain: sepolia, transport: custom({ request: async ({ method }) => {
    reads.push(method);
    if (method === "eth_chainId") return "0xaa36a7";
    if (method === "eth_getTransactionCount") return "0x0";
    throw new Error(`Unexpected read ${method}`);
  } }) });
  Object.assign(publicClient, { waitForTransactionReceipt: async ({ hash }: { hash: string }) => {
    receiptHash = hash; return { status: "success" };
  } });
  process.env.KOHAKU_SUBMIT_RPC_URL = "https://read.invalid/submit";
  try {
    const result = await withFakeTor(async (url, init) => {
      assert.equal(url, "https://read.invalid/submit");
      const request = JSON.parse(String(init?.body)) as Rpc;
      sends.push(request);
      return successfulRpc(request);
    }, () => runWithActivityLog({ walletDir, password: "pw", chainId: 11155111n, operation: "transfer" }, () =>
      withTor(true, { rpcUrl: "https://read.invalid/reads", walletDir }, () =>
        sendTransactionAndWait(makeWalletClient(key, publicClient, "https://read.invalid/reads"), publicClient, {
          to: recipient, value: 12n, gas: 21_000n, maxFeePerGas: 10n, maxPriorityFeePerGas: 1n,
        }))));
    assert.deepEqual(sends.map((request) => request.method), ["eth_chainId", "eth_sendRawTransaction"]);
    const signed = sends[1]!.params[0] as Hex;
    assert.equal(result, keccak256(signed));
    assert.equal(receiptHash, result);
    assert.equal(parseTransaction(signed).chainId, 11155111);
    assert.equal(parseTransaction(signed).to?.toLowerCase(), recipient);
    assert.equal(parseTransaction(signed).value, 12n);
    assert.ok(reads.includes("eth_getTransactionCount"));
    assert.ok(!reads.some((method) => method.startsWith("eth_send")));
    assert.deepEqual(clearRequests, []);
    const activity = readActivity(walletDir, "pw");
    assert.equal(activity.length, 1);
    assert.equal(activity[0]!.status, "confirmed");
    assert.equal(activity[0]!.txHash, result);
    const traffic = readNetworkTrafficLog(walletDir);
    assert.equal(traffic.filter((entry) => entry.rpcMethod === "eth_sendRawTransaction").length, 1);
    assert.ok(traffic.every((entry) => entry.via === "tor"));
    assert.doesNotMatch(JSON.stringify(traffic), new RegExp(signed.slice(2)));
  } finally { rmSync(walletDir, { recursive: true, force: true }); }
});

it("verifies the submission chain before revealing signed bytes", async () => {
  const methods: string[] = [];
  const attempts: string[] = [];
  await withFakeTor(async (_url, init) => {
    const request = JSON.parse(String(init?.body)) as Rpc;
    methods.push(request.method);
    return response(request, "0x1");
  }, () => assert.rejects(submitSignedTransaction(raw, 11155111n, (hash) => attempts.push(hash)), /different or invalid chain/));
  assert.deepEqual(methods, ["eth_chainId"]);
  assert.deepEqual(attempts, []);
  assert.deepEqual(clearRequests, []);
});

it("keeps ambiguous wallet sends in activity and omits signed bytes from errors and traffic logs", async () => {
  const walletDir = mkdtempSync(join(tmpdir(), "kohaku-submit-unknown-"));
  const publicClient = createPublicClient({ chain: sepolia, transport: custom({ request: async ({ method }) => {
    if (method === "eth_chainId") return "0xaa36a7";
    if (method === "eth_getTransactionCount") return "0x0";
    throw new Error(`Unexpected read ${method}`);
  } }) });
  let signed: Hex | undefined;
  try {
    await withFakeTor(async (_url, init) => {
      const request = JSON.parse(String(init?.body)) as Rpc;
      if (request.method === "eth_chainId") return response(request, "0xaa36a7");
      signed = request.params[0] as Hex;
      throw new Error(`Transport echoed signed bytes ${signed}`);
    }, () => runWithActivityLog({ walletDir, password: "pw", chainId: 11155111n, operation: "shield" }, () =>
      withTor(true, { walletDir }, () => assert.rejects(
        sendTransactionAndWait(makeWalletClient(key, publicClient, "https://reads.invalid"), publicClient, {
          to: recipient, value: 12n, gas: 21_000n, maxFeePerGas: 10n, maxPriorityFeePerGas: 1n,
        }), (error: unknown) => {
          assert.ok(error instanceof TransactionSubmissionError);
          assert.ok(signed);
          assert.equal(error.txHash, keccak256(signed));
          assert.ok(!error.message.includes(signed));
          return true;
        }))));
    assert.ok(signed);
    const [entry] = readActivity(walletDir, "pw");
    assert.equal(entry?.status, "submitted");
    assert.equal(entry?.txHash, keccak256(signed));
    const traffic = readNetworkTrafficLog(walletDir);
    assert.ok(!JSON.stringify(traffic).includes(signed));
    assert.equal(traffic.filter((item) => item.rpcMethod === "eth_sendRawTransaction").length, 1);
    assert.deepEqual(clearRequests, []);
  } finally { rmSync(walletDir, { recursive: true, force: true }); }
});

for (const outcome of ["transport", "reject", "mismatch"] as const) {
  it(`retains the deterministic hash for ${outcome} outcomes without resending or echoing signed bytes`, async () => {
    const methods: string[] = [];
    const attempts: string[] = [];
    await withFakeTor(async (_url, init) => {
      const request = JSON.parse(String(init?.body)) as Rpc;
      methods.push(request.method);
      if (request.method === "eth_chainId") return response(request, "0xaa36a7");
      if (outcome === "transport") throw new Error("Tor connection lost");
      if (outcome === "reject") return Response.json({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: `Echo ${raw}` } });
      return response(request, `0x${"00".repeat(32)}`);
    }, () => assert.rejects(submitSignedTransaction(raw, 11155111n, (hash) => attempts.push(hash)), (error: unknown) => {
      assert.ok(error instanceof TransactionSubmissionError);
      assert.equal(error.txHash, hash);
      assert.doesNotMatch(error.message, /deadbeef|Echo/);
      return true;
    }));
    assert.deepEqual(methods, ["eth_chainId", "eth_sendRawTransaction"]);
    assert.deepEqual(attempts, [hash]);
    assert.deepEqual(clearRequests, []);
  });
}

it("does not fall back to clearnet when Tor bootstrap fails", async () => {
  const attempts: string[] = [];
  await withFakeTor(async () => { assert.fail("Tor fetch must not run"); }, () =>
    assert.rejects(submitSignedTransaction(raw, 11155111n, (hash) => attempts.push(hash)), /bootstrap failed/),
  async () => { throw new Error("bootstrap failed"); });
  assert.deepEqual(attempts, []);
  assert.deepEqual(clearRequests, []);
});

for (const optOut of ["scope", "environment"] as const) {
  it(`honors the explicit ${optOut} Tor opt-out in nested submission helpers`, async () => {
    const requests: Rpc[] = [];
    clearFetch = async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as Rpc;
      requests.push(request);
      return successfulRpc(request);
    };
    if (optOut === "environment") process.env.KOHAKU_WITHOUT_TOR = "1";
    await withFakeTor(async () => { assert.fail("Tor must stay disabled"); }, async () => {
      const submit = () => submitSignedTransaction(raw, 11155111n, () => {});
      assert.equal(await (optOut === "scope" ? withTor(false, {}, submit) : submit()), hash);
    }, async () => { assert.fail("Tor must not bootstrap"); });
    assert.deepEqual(requests.map((request) => request.method), ["eth_chainId", "eth_sendRawTransaction"]);
  });
}
