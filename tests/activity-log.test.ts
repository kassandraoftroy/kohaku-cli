import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readActivity, recordSubmission, runWithActivityLog } from "../src/utils/activity-log.js";
import { broadcastPreparedPrivateOp } from "../src/lib/unshield-flow.js";
import { sendTransactionAndWait } from "../src/utils/viem-tx.js";

const hash = `0x${"a".repeat(64)}` as const;
const userOpHash = `0x${"b".repeat(64)}`;

test("activity is encrypted and updates one submission with the actual transaction hash", () => {
  const walletDir = mkdtempSync(join(tmpdir(), "kohaku-activity-"));
  try {
    runWithActivityLog({ walletDir, password: "test-password", chainId: 1n, operation: "shield", protocol: "tornado" }, () => {
      const update = recordSubmission({ userOpHash });
      assert.equal(readActivity(walletDir, "test-password")[0].status, "submitted");
      update({ txHash: hash, status: "confirmed" });
    });
    const entries = readActivity(walletDir, "test-password");
    assert.equal(entries.length, 1);
    assert.equal(entries[0].txHash, hash);
    assert.equal(entries[0].userOpHash, userOpHash);
    assert.equal(entries[0].operation, "shield");
    assert.equal(entries[0].chainId, "1");
    assert.equal(entries[0].status, "confirmed");
    const file = readdirSync(join(walletDir, "activity"))[0];
    const raw = readFileSync(join(walletDir, "activity", file), "utf8");
    assert.ok(!raw.includes(hash) && !raw.includes("shield"));
    assert.throws(() => readActivity(walletDir, "wrong-password"));
  } finally { rmSync(walletDir, { recursive: true, force: true }); }
});

test("EOA submissions survive receipt timeouts and record reverted receipts", async () => {
  const walletDir = mkdtempSync(join(tmpdir(), "kohaku-activity-"));
  const wallet = { account: {}, chain: {}, sendTransaction: async () => hash } as never;
  try {
    await runWithActivityLog({ walletDir, password: "test-password", chainId: 11155111n, operation: "transfer" }, async () => {
      await assert.rejects(sendTransactionAndWait(wallet, { waitForTransactionReceipt: async () => { throw new Error("timeout"); } } as never, { to: hash }), /timeout/);
      assert.equal(readActivity(walletDir, "test-password")[0].status, "submitted");
      await assert.rejects(sendTransactionAndWait(wallet, { waitForTransactionReceipt: async () => ({ status: "reverted" }) } as never, { to: hash }), /Transaction reverted/);
    });
    const entries = readActivity(walletDir, "test-password");
    assert.equal(entries.length, 2);
    assert.equal(entries.filter((e) => e.status === "reverted").length, 1);
    assert.equal(entries.filter((e) => e.status === "submitted").length, 1);
  } finally { rmSync(walletDir, { recursive: true, force: true }); }
});

test("wallet activity contexts remain isolated across concurrent operations", async () => {
  const walletDir = mkdtempSync(join(tmpdir(), "kohaku-activity-"));
  try {
    await Promise.all(["shield", "unshield"].map((operation) => runWithActivityLog({ walletDir, password: "test-password", chainId: 1n, operation }, async () => {
      await Promise.resolve();
      recordSubmission({ txHash: hash });
    })));
    assert.deepEqual(readActivity(walletDir, "test-password").map((e) => e.operation).sort(), ["shield", "unshield"]);
  } finally { rmSync(walletDir, { recursive: true, force: true }); }
});


test("Railgun activity captures the mined transaction hash separately from its UserOp hash", async () => {
  const walletDir = mkdtempSync(join(tmpdir(), "kohaku-activity-"));
  const bundler = {
    sendUserOperation: async () => userOpHash,
    waitForReceipt: async () => ({ success: true, receipt: { transactionHash: hash } }),
  };
  const plugin = { bundler, broadcast: async () => {
    const submitted = await bundler.sendUserOperation();
    assert.equal(submitted, userOpHash);
    await bundler.waitForReceipt();
  } };
  try {
    const result = await runWithActivityLog({ walletDir, password: "test-password", chainId: 1n, operation: "unshield", protocol: "railgun" }, () =>
      broadcastPreparedPrivateOp("railgun", {} as never, plugin, {}, 1n));
    assert.deepEqual(result, { userOpHash, txHash: hash });
    const [entry] = readActivity(walletDir, "test-password");
    assert.equal(entry.txHash, hash);
    assert.equal(entry.userOpHash, userOpHash);
    assert.equal(entry.status, "confirmed");
  } finally { rmSync(walletDir, { recursive: true, force: true }); }
});
