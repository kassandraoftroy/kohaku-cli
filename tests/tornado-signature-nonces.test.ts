import assert from "node:assert/strict";
import { it } from "node:test";
import type { Storage } from "@kohaku-eth/plugins";
import { tornadoSignatureNonceStorage, withTornadoNonceReservation } from "../src/utils/tornado-signature-nonces.js";

const key = "tornado-cash-state-1-123";
function memory(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  const writes: Array<[string, string]> = [];
  const storage: Storage = {
    _brand: "Storage", get: async (key) => values.get(key) ?? null,
    set: async (key, value) => { values.set(key, value); writes.push([key, value]); },
  };
  return { storage, values, writes };
}
const state = (nextNonce?: number, history = 10) => JSON.stringify({
  history, ...(nextNonce === undefined ? {} : { signatureNonces: { nextNonce } }),
});

it("reserves nonce ranges in an older SDK snapshot before returning commitments", async () => {
  const source = memory({ [key]: state() });
  const storage = tornadoSignatureNonceStorage(source.storage);
  assert.equal(storage, tornadoSignatureNonceStorage(source.storage));
  assert.equal(storage, tornadoSignatureNonceStorage(storage));
  const calls = await withTornadoNonceReservation(storage, key, async (nextNonce) => {
    assert.equal(nextNonce, 0);
    assert.equal(source.writes.length, 0);
    return { value: ["commitment0", "commitment1"], nextNonce: 2 };
  });
  assert.deepEqual(calls, ["commitment0", "commitment1"]);
  assert.deepEqual(JSON.parse(source.values.get(key)!), { history: 10, signatureNonces: { nextNonce: 2 } });
});

it("preserves the high watermark when an SDK worker writes a stale snapshot", async () => {
  const source = memory({ [key]: state(32) });
  const storage = tornadoSignatureNonceStorage(source.storage);
  await storage.set(key, state(2, 11));
  assert.deepEqual(JSON.parse((await storage.get(key))!), { history: 11, signatureNonces: { nextNonce: 32 } });
  await storage.set(key, state(undefined, 12));
  assert.deepEqual(JSON.parse((await storage.get(key))!), { history: 12, signatureNonces: { nextNonce: 32 } });
  await storage.set(key, state(40, 13));
  assert.deepEqual(JSON.parse((await storage.get(key))!), { history: 13, signatureNonces: { nextNonce: 40 } });
});

it("serializes derivation and persistence with competing CLI allocations and SDK writes", async () => {
  const source = memory({ [key]: state(20) });
  const storage = tornadoSignatureNonceStorage(source.storage);
  let release!: () => void;
  let started!: () => void;
  const deriving = new Promise<void>((resolve) => { started = resolve; });
  const ready = new Promise<void>((resolve) => { release = resolve; });
  const starts: number[] = [];
  const first = withTornadoNonceReservation(storage, key, async (start) => {
    starts.push(start); started(); await ready;
    return { value: "first", nextNonce: start + 5 };
  });
  await deriving;
  const staleWrite = storage.set(key, state(1, 15));
  const second = withTornadoNonceReservation(source.storage, key, async (start) => {
    starts.push(start); return { value: "second", nextNonce: start + 4 };
  });
  assert.deepEqual(starts, [20]);
  release();
  assert.deepEqual(await Promise.all([first, staleWrite, second]), ["first", undefined, "second"]);
  assert.deepEqual(starts, [20, 25]);
  assert.deepEqual(JSON.parse(source.values.get(key)!), { history: 15, signatureNonces: { nextNonce: 29 } });
});

it("does not consume a range when derivation fails, and keeps the queue usable", async () => {
  const source = memory({ [key]: state(5) });
  const storage = tornadoSignatureNonceStorage(source.storage);
  await assert.rejects(withTornadoNonceReservation(storage, key, async () => { throw new Error("signer failed"); }), /signer failed/);
  assert.equal(source.writes.length, 0);
  assert.equal(await withTornadoNonceReservation(storage, key, async (start) => ({ value: start, nextNonce: start + 1 })), 5);
});

it("does not release commitments when durable reservation fails", async () => {
  const source = memory({ [key]: state(5) });
  let fail = true;
  const failing: Storage = { ...source.storage, set: async (key, value) => {
    if (fail) throw new Error("disk full");
    await source.storage.set(key, value);
  } };
  const storage = tornadoSignatureNonceStorage(failing);
  await assert.rejects(withTornadoNonceReservation(storage, key, async (start) => ({ value: "commitment", nextNonce: start + 1 })), /disk full/);
  assert.equal(JSON.parse(source.values.get(key)!).signatureNonces.nextNonce, 5);
  fail = false;
  await withTornadoNonceReservation(storage, key, async (start) => ({ value: "retry", nextNonce: start + 1 }));
  assert.equal(JSON.parse(source.values.get(key)!).signatureNonces.nextNonce, 6);
});

for (const invalid of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, "32", null]) {
  it(`fails closed for malformed persisted reservation ${String(invalid)}`, async () => {
    const malformed = JSON.stringify({ signatureNonces: { nextNonce: invalid } });
    const source = memory({ [key]: malformed });
    const storage = tornadoSignatureNonceStorage(source.storage);
    await assert.rejects(withTornadoNonceReservation(storage, key, async () => ({ value: "unsafe", nextNonce: 32 })), /Invalid Tornado signature nonce/);
    await assert.rejects(storage.set(key, state(40)), /Invalid Tornado signature nonce/);
    assert.equal(source.values.get(key), malformed);
    assert.equal(source.writes.length, 0);
  });
}

it("rejects missing snapshots and invalid or decreasing allocations", async () => {
  const source = memory({ [key]: state(10) });
  const storage = tornadoSignatureNonceStorage(source.storage);
  await assert.rejects(withTornadoNonceReservation(storage, "tornado-cash-state-2-123", async () => ({ value: null, nextNonce: 1 })), /before syncing/);
  await assert.rejects(withTornadoNonceReservation(storage, "unrelated", async () => ({ value: null, nextNonce: 1 })), /Invalid Tornado signature state key/);
  for (const nextNonce of [9, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(withTornadoNonceReservation(storage, key, async () => ({ value: null, nextNonce })), /Invalid Tornado signature nonce allocation/);
  }
  assert.equal(source.writes.length, 0);
});

it("only merges Tornado snapshots, including prefixed signature state", async () => {
  const source = memory({ [`sig:${key}`]: state(25) });
  const storage = tornadoSignatureNonceStorage(source.storage);
  await storage.set(`sig:${key}`, state(0));
  assert.equal(JSON.parse(source.values.get(`sig:${key}`)!).signatureNonces.nextNonce, 25);
  await storage.set("unrelated", "not json");
  assert.equal(await storage.get("unrelated"), "not json");
});


it("does not expose malformed snapshot contents in recovery errors", async () => {
  const source = memory({ [key]: '{"secret":"private-note-preimage"' });
  const storage = tornadoSignatureNonceStorage(source.storage);
  await assert.rejects(withTornadoNonceReservation(storage, key, async () => ({ value: "unsafe", nextNonce: 1 })), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, "Invalid Tornado signature nonce snapshot.");
    assert.doesNotMatch(error.message, /private-note-preimage/);
    return true;
  });
});
