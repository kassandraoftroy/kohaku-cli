import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { privateBalanceCache } from "../src/lib/private-balance-cache.js";
import { loadPrivateBalancesOnly } from "../src/lib/balances-snapshot.js";

test("all-recent private balances use encrypted views without opening wallets or starting Tor", async () => {
  const walletDir = mkdtempSync(join(tmpdir(), "kohaku-recent-balances-"));
  const methods: string[] = [];
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    methods.push(request.method);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: "0xaa36a7" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const opts = { walletDir, rpcUrl: `http://127.0.0.1:${address.port}`, chainId: 11155111n,
    password: "fixture password", mnemonic: "not a seed; no keystore should be opened" };
  const statuses: string[] = [];
  try {
    const cache = privateBalanceCache(opts);
    for (const protocol of ["railgun", "privacy-pools", "tornado"] as const) {
      cache.write(protocol, { balances: [{ asset: { __type: "erc20", contract: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" }, amount: 1234567890123456789n }] });
    }
    const loaded = await loadPrivateBalancesOnly({ ...opts, recentPrivateBalances: true,
      includeProtocols: ["railgun", "privacy-pools", "tornado"], onTorStatus: (status) => statuses.push(status) });
    for (const rows of [loaded.privateRailgun, loaded.privatePrivacyPools, loaded.privateTornado]) {
      assert.equal(rows[0]?.raw_token_holdings, "1234567890123456789");
    }
    assert.deepEqual(statuses, []);
    assert.ok(methods.length > 0);
    assert.ok(methods.every((method) => method === "eth_chainId"), methods.join(","));
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(walletDir, { recursive: true, force: true });
  }
});
