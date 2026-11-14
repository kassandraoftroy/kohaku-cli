import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import type { Host } from "@kohaku-eth/plugins";
import { PaymasterBroadcastError } from "@kohaku-eth/tornado-cash";
import { entryPoint08Address } from "viem/account-abstraction";
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

async function withBundler(
  outcome: "success" | "revert" | "reject" | "known" | "unknown" | "duplicate",
  run: (url: string, methods: string[]) => Promise<void>,
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
          message: outcome === "duplicate" ? "Already known" : "AA23 rejected" } })); return;
      }
      let result: unknown = null;
      if (method === "eth_sendUserOperation") result = userOpHash;
      if (method === "eth_getUserOperationByHash" && outcome === "known") result = { userOperation: operation };
      if (method === "eth_getUserOperationReceipt") result = {
        userOpHash, sender, nonce: "0x0", success: outcome !== "revert",
        actualGasCost: "0x1", actualGasUsed: "0x1", logs: [],
        receipt: { transactionHash: txHash, transactionIndex: "0x0", blockHash: txHash,
          blockNumber: "0x1", from: sender, to: entryPoint08Address, contractAddress: null,
          cumulativeGasUsed: "0x1", gasUsed: "0x1", effectiveGasPrice: "0x1",
          logs: [], logsBloom: `0x${"00".repeat(256)}`, status: "0x1", type: "0x2" },
      };
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
        const [result] = await createTorAwarePaymasterBroadcaster(1n).broadcast([withdrawal(url)]);
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
        const host = { network: { fetch: globalThis.fetch } } as Host;
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
      const result = createTorAwarePaymasterBroadcaster(1n).broadcast([withdrawal(url)]);
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
