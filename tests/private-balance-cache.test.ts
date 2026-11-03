import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { privateBalanceCache, PRIVATE_BALANCE_MAX_AGE_MS } from "../src/lib/private-balance-cache.js";

function fixture() {
  const walletDir = mkdtempSync(join(tmpdir(), "kohaku-balance-view-"));
  const opts = { walletDir, password: "fixture password", mnemonic: "public synthetic identity", chainId: 1n, rpcUrl: "https://rpc.invalid" };
  const amount = 2n ** 128n + 1n;
  const data = { balances: [{ asset: { __type: "native" as const }, amount }],
    rawNotes: [{ memo: "private fixture memo", amount }] };
  return { opts, data, cleanup: () => rmSync(walletDir, { recursive: true, force: true }) };
}

test("recent balance views survive reopening, preserve wei and stay encrypted", () => {
  const f = fixture();
  try {
    const now = Date.now();
    privateBalanceCache(f.opts).write("railgun", f.data, now);
    const hit = privateBalanceCache(f.opts).read("railgun", true, now + 1);
    assert.deepEqual(hit?.data, f.data);
    const path = join(f.opts.walletDir, "private-balances-cache.json");
    assert.doesNotMatch(readFileSync(path, "utf8"), /private fixture memo|balances|synthetic identity/);
    assert.equal(statSync(path).mode & 0o777, 0o600);
  } finally { f.cleanup(); }
});

test("expired, future, wrong-identity and insufficient-detail views never qualify", () => {
  const f = fixture();
  try {
    const now = Date.now();
    const cache = privateBalanceCache(f.opts);
    cache.write("tornado", { balances: f.data.balances }, now);
    assert.ok(cache.read("tornado", false, now));
    assert.equal(cache.read("tornado", true, now), null);
    assert.equal(cache.read("tornado", false, now - 1), null);
    assert.equal(cache.read("tornado", false, now + PRIVATE_BALANCE_MAX_AGE_MS), null);
    for (const replacement of [{ password: "wrong" }, { mnemonic: "another identity" }, { chainId: 2n }, { rpcUrl: "https://other.invalid" }]) {
      assert.equal(privateBalanceCache({ ...f.opts, ...replacement }).read("tornado", false, now), null);
    }
  } finally { f.cleanup(); }
});

test("protocol state and operation activity invalidate a view even when mtime and size are preserved", () => {
  const f = fixture();
  try {
    const path = join(f.opts.walletDir, "rg-v2-storage.json");
    writeFileSync(path, "state1");
    const previous = statSync(path);
    const cache = privateBalanceCache(f.opts);
    cache.write("railgun", f.data);
    assert.ok(cache.read("railgun", false));
    writeFileSync(path, "state2");
    utimesSync(path, previous.atime, previous.mtime);
    assert.equal(cache.read("railgun", false), null);
    cache.write("railgun", f.data);
    mkdirSync(join(f.opts.walletDir, "activity"));
    writeFileSync(join(f.opts.walletDir, "activity", "fixture.json"), "operation");
    assert.equal(cache.read("railgun", false), null);
  } finally { f.cleanup(); }
});

test("a corrupted display cache is discarded without returning private values", () => {
  const f = fixture();
  try {
    privateBalanceCache(f.opts).write("privacy-pools", f.data);
    const path = join(f.opts.walletDir, "private-balances-cache.json");
    const envelope = JSON.parse(readFileSync(path, "utf8"));
    envelope.tag = Buffer.alloc(16).toString("base64");
    writeFileSync(path, JSON.stringify(envelope));
    assert.equal(privateBalanceCache(f.opts).read("privacy-pools", false), null);
  } finally { f.cleanup(); }
});
