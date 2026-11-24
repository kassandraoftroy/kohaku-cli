import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import type { Host } from "@kohaku-eth/plugins";
import { PaymasterBroadcastError } from "@kohaku-eth/tornado-cash";
import { entryPoint08Address, getUserOperationHash } from "viem/account-abstraction";
import { broadcastPreparedPrivateOp } from "../src/lib/unshield-flow.js";
import { createTorAwarePaymasterBroadcaster, type SerializedUserOperation } from "../src/utils/tornado-paymaster-broadcaster.js";
import { readActivity, runWithActivityLog } from "../src/utils/activity-log.js";

const userOpHash = `0x${"11".repeat(32)}` as const;
const txHash = `0x${"22".repeat(32)}` as const;
const sender = `0x${"33".repeat(20)}` as const;
const operation: SerializedUserOperation = {
  sender, nonce: "0x0", callData: "0xdeadbeef", callGasLimit: "0x10000",
  verificationGasLimit: "0x10000", preVerificationGas: "0x10000",
  maxFeePerGas: "0x1", maxPriorityFeePerGas: "0x1", signature: "0xcafebabe",
};

function hostWith(request: Host["provider"]["request"] = async () => {
  throw new Error("No chain nonce response configured");
}): Host {
  return {
    network: { fetch: (...args) => globalThis.fetch(...args) },
    provider: { request },
  } as Host;
}

async function withBundler(
  outcome: "success" | "revert" | "reject" | "known" | "unknown" | "duplicate",
  run: (url: string, methods: string[]) => Promise<void>,
  overrides: {
    sendResult?: unknown;
    lookup?: unknown;
    rejectionMessage?: string;
    receipt?: (value: Record<string, unknown>) => unknown;
  } = {},
) {
  const methods: string[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      const { id, method } = JSON.parse(body);
      methods.push(method);
      res.setHeader("content-type", "application/json");
      if (method === "eth_sendUserOperation" && ["known", "unknown"].includes(outcome)) {
        res.writeHead(503); res.end("service unavailable"); return;
      }
      if (method === "eth_sendUserOperation" && ["reject", "duplicate"].includes(outcome)) {
        res.end(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32500,
          message: overrides.rejectionMessage ?? (outcome === "duplicate" ? "Already known" : "AA23 rejected") } })); return;
      }
      let result: unknown = null;
      if (method === "eth_sendUserOperation") result = "sendResult" in overrides ? overrides.sendResult : userOpHash;
      if (method === "eth_getUserOperationByHash") result = "lookup" in overrides ? overrides.lookup :
        outcome === "known" ? { entryPoint: entryPoint08Address, userOperation: operation } : null;
      if (method === "eth_getUserOperationReceipt") result = {
        userOpHash, sender, nonce: "0x0", success: outcome !== "revert",
        actualGasCost: "0x1", actualGasUsed: "0x1", logs: [],
        receipt: { transactionHash: txHash, transactionIndex: "0x0", blockHash: txHash,
          blockNumber: "0x1", from: sender, to: entryPoint08Address, contractAddress: null,
          cumulativeGasUsed: "0x1", gasUsed: "0x1", effectiveGasPrice: "0x1",
          logs: [], logsBloom: `0x${"00".repeat(256)}`, status: "0x1", type: "0x2" },
      };
      if (method === "eth_getUserOperationReceipt" && overrides.receipt) {
        result = overrides.receipt(result as Record<string, unknown>);
      }
      res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address() as { port: number };
    await run(`http://127.0.0.1:${port}`, methods);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
}

function withdrawal(url: string) {
  return { mode: "paymaster" as const, bundlerUrl: url,
    entryPointAddress: entryPoint08Address, userOperation: operation, userOpHash };
}

it("broadcast returns on acceptance; wait confirms success and updates activity", async () => {
  const walletDir = mkdtempSync(join(tmpdir(), "kohaku-paymaster-"));
  try {
    await runWithActivityLog({ walletDir, password: "password", chainId: 1n, operation: "unshield" }, () =>
      withBundler("success", async (url, methods) => {
        const [result] = await createTorAwarePaymasterBroadcaster(1n, hostWith()).broadcast([withdrawal(url)]);
        assert.equal(result.userOpHash, userOpHash);
        assert.deepEqual(methods, ["eth_sendUserOperation"]);
        assert.equal(readActivity(walletDir, "password")[0].status, "submitted");
        assert.deepEqual(await result.wait(), { txHash });
        assert.equal(readActivity(walletDir, "password")[0].status, "confirmed");
      }));
  } finally { rmSync(walletDir, { recursive: true, force: true }); }
});

for (const protocol of ["tornado", "privacy-pools"] as const) {
  for (const outcome of ["success", "revert"] as const) {
    it(`${protocol} CLI broadcast waits and ${outcome === "success" ? "returns the mined hash" : "rejects a reverted UserOp"}`, async () => {
      await withBundler(outcome, async (url, methods) => {
        const op = protocol === "tornado" ? { withdrawals: [withdrawal(url)] } : { withdrawal: withdrawal(url) };
        const host = hostWith();
        const result = broadcastPreparedPrivateOp(protocol, host, {}, op, 1n);
        if (outcome === "revert") {
          await assert.rejects(result, (err: unknown) => err instanceof PaymasterBroadcastError &&
            err.failure === "reverted" && err.userOpHash === userOpHash && err.txHash === txHash);
        } else {
          const confirmed = await result;
          assert.deepEqual(confirmed, protocol === "tornado" ? [{ id: userOpHash, txHash }] : { userOpHash, txHash });
        }
        assert.ok(methods.includes("eth_getUserOperationReceipt"));
      });
    });
  }
}

for (const outcome of ["reject", "known", "unknown", "duplicate"] as const) {
  it(`handles ${outcome} send outcomes without resending or exposing the signed operation`, async () => {
    await withBundler(outcome, async (url, methods) => {
      const result = createTorAwarePaymasterBroadcaster(1n, hostWith()).broadcast([withdrawal(url)]);
      if (outcome === "known" || outcome === "duplicate") {
        const [accepted] = await result;
        assert.equal(accepted.userOpHash, userOpHash);
        await accepted.wait();
      } else {
        await assert.rejects(result, (err: unknown) => {
          assert.ok(err instanceof PaymasterBroadcastError);
          assert.equal(err.failure, outcome === "reject" ? "not-accepted" : "unconfirmed");
          assert.equal(err.userOpHash, userOpHash);
          assert.doesNotMatch(JSON.stringify(err) + err.message, /cafebabe|deadbeef|Request body/);
          return true;
        });
      }
      assert.equal(methods.filter((method) => method === "eth_sendUserOperation").length, 1);
    });
  });
}

for (const sendResult of [null, "0x1234", txHash]) {
  it(`does not accept a malformed or mismatched send hash (${String(sendResult)})`, async () => {
    await withBundler("success", async (url, methods) => {
      await assert.rejects(createTorAwarePaymasterBroadcaster(1n, hostWith()).broadcast([withdrawal(url)]),
        (error: unknown) => error instanceof PaymasterBroadcastError && error.failure === "unconfirmed" && error.userOpHash === userOpHash);
      assert.equal(methods.filter((method) => method === "eth_sendUserOperation").length, 1);
    }, { sendResult });
  });
}

for (const lookup of [
  { userOperation: operation },
  { entryPoint: sender, userOperation: operation },
  { entryPoint: entryPoint08Address, userOperation: { ...operation, callData: "0x00" } },
  { entryPoint: entryPoint08Address, userOperation: { ...operation, signature: "0x00" } },
  { entryPoint: entryPoint08Address, userOperation: { ...operation, factory: sender } },
]) {
  it("does not recover a lost response from a different signed operation or EntryPoint", async () => {
    await withBundler("known", async (url) => {
      await assert.rejects(createTorAwarePaymasterBroadcaster(1n, hostWith()).broadcast([withdrawal(url)]),
        (error: unknown) => error instanceof PaymasterBroadcastError && error.failure === "unconfirmed");
    }, { lookup });
  });
}

it("only accepts the exact Already known rejection and strips bundler text from errors", async () => {
  await withBundler("duplicate", async (url) => {
    await assert.rejects(createTorAwarePaymasterBroadcaster(1n, hostWith()).broadcast([withdrawal(url)]), (error: unknown) => {
      assert.ok(error instanceof PaymasterBroadcastError);
      assert.equal(error.failure, "not-accepted");
      assert.doesNotMatch(error.message + JSON.stringify(error), /cafebabe|deadbeef|not already known/);
      return true;
    });
  }, { rejectionMessage: "not already known: AA23 0xcafebabe 0xdeadbeef" });
});

for (const receipt of [
  (value: Record<string, unknown>) => ({ ...value, userOpHash: txHash }),
  (value: Record<string, unknown>) => ({ ...value, success: "true" }),
  (value: Record<string, unknown>) => ({ ...value, receipt: { ...(value.receipt as object), status: "0x0" } }),
  (value: Record<string, unknown>) => ({ ...value, receipt: { ...(value.receipt as object), status: undefined } }),
  (value: Record<string, unknown>) => ({ ...value, receipt: { ...(value.receipt as object), transactionHash: "0x1234" } }),
]) {
  it("leaves malformed or contradictory receipts unconfirmed in activity", async () => {
    const walletDir = mkdtempSync(join(tmpdir(), "kohaku-paymaster-receipt-"));
    try {
      await runWithActivityLog({ walletDir, password: "password", chainId: 1n, operation: "unshield" }, () =>
        withBundler("success", async (url) => {
          const [result] = await createTorAwarePaymasterBroadcaster(1n, hostWith()).broadcast([withdrawal(url)]);
          await assert.rejects(result.wait(),
            (error: unknown) => error instanceof PaymasterBroadcastError && error.failure === "unconfirmed");
          assert.equal(readActivity(walletDir, "password")[0].status, "submitted");
        }, { receipt }));
    } finally { rmSync(walletDir, { recursive: true, force: true }); }
  });
}

it("routes bundler requests through Host.network and preserves stale nonce diagnostics", async () => {
  await withBundler("reject", async (url) => {
    let fetches = 0;
    const host = hostWith(async () => `0x${"0".repeat(63)}1`);
    host.network.fetch = (...args) => { fetches++; return globalThis.fetch(...args); };
    await assert.rejects(createTorAwarePaymasterBroadcaster(1n, host).broadcast([withdrawal(url)]), (error: unknown) => {
      assert.ok(error instanceof PaymasterBroadcastError);
      assert.deepEqual(error.staleNonce, { kind: "entry-point", signed: 0n, current: 1n });
      return true;
    });
    assert.equal(fetches, 2);
  });
});

it("waits for a shared executor's first operation before sending its second", async () => {
  await withBundler("success", async (url, methods) => {
    const results = await createTorAwarePaymasterBroadcaster(1n, hostWith()).broadcast([withdrawal(url), withdrawal(url)]);
    assert.equal(results.length, 2);
    assert.deepEqual(methods, ["eth_sendUserOperation", "eth_getUserOperationReceipt", "eth_sendUserOperation"]);
  });
});

it("recovers an older SimpleAccount payload using a hash that includes its deployment", async () => {
  const factory = `0x${"44".repeat(20)}` as const;
  const factoryData = "0x123456" as const;
  const legacyOperation = { ...operation, factory, factoryData };
  const expected = getUserOperationHash({
    chainId: 1, entryPointAddress: entryPoint08Address, entryPointVersion: "0.8",
    userOperation: { sender, callData: operation.callData, signature: operation.signature,
      factory, factoryData, nonce: 0n, callGasLimit: 0x10000n,
      verificationGasLimit: 0x10000n, preVerificationGas: 0x10000n,
      maxFeePerGas: 1n, maxPriorityFeePerGas: 1n },
  });
  await withBundler("duplicate", async (url) => {
    const [result] = await createTorAwarePaymasterBroadcaster(1n, hostWith()).broadcast([
      { ...withdrawal(url), userOperation: legacyOperation, userOpHash: undefined },
    ]);
    assert.equal(result.userOpHash, expected);
  });
});

it("records a validated reverted UserOp with its bundle hash", async () => {
  const walletDir = mkdtempSync(join(tmpdir(), "kohaku-paymaster-revert-"));
  try {
    await runWithActivityLog({ walletDir, password: "password", chainId: 1n, operation: "unshield" }, () =>
      withBundler("revert", async (url) => {
        const [result] = await createTorAwarePaymasterBroadcaster(1n, hostWith()).broadcast([withdrawal(url)]);
        await assert.rejects(result.wait(), (error: unknown) => error instanceof PaymasterBroadcastError && error.failure === "reverted");
        const [entry] = readActivity(walletDir, "password");
        assert.equal(entry.status, "reverted");
        assert.equal(entry.txHash, txHash);
      }));
  } finally { rmSync(walletDir, { recursive: true, force: true }); }
});
