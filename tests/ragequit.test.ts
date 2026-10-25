import assert from "node:assert/strict";
import { test } from "node:test";
import { assertRagequitNote } from "../src/commands/ragequit.js";

test("ragequit only permits an unapproved, unspent note from its depositor", () => {
  const note = { label: 1n, balance: 100n, approved: false, depositor: 1n };
  const sender = "0x0000000000000000000000000000000000000001";
  assert.doesNotThrow(() => assertRagequitNote(note, sender));
  assert.throws(() => assertRagequitNote({ ...note, approved: true }, sender), /approved/);
  assert.throws(() => assertRagequitNote({ ...note, balance: 0n }, sender), /no balance/);
  assert.throws(() => assertRagequitNote(note, "0x0000000000000000000000000000000000000002"), /original depositor/);
});
