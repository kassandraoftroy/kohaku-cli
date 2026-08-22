import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress } from "viem";

import {
  looksLikeName,
  maybeResolveName,
  resolveAddressOrName,
} from "../src/utils/resolve-name.js";

const ADDR = "0x9dAEf1EA5CC90C0F9DA9a5F0B49DA10510c34502";
const ADDR_LOWER = ADDR.toLowerCase();

describe("looksLikeName", () => {
  it("is true only for a non-address with a supported TLD", () => {
    assert.equal(looksLikeName("alice.eth"), true);
    assert.equal(looksLikeName("Alice.GWEI"), true);
    assert.equal(looksLikeName("x.wei"), true);
    assert.equal(looksLikeName(ADDR), false);
    assert.equal(looksLikeName("alice"), false);
    assert.equal(looksLikeName("alice.com"), false);
  });
});

describe("resolveAddressOrName", () => {
  it("checksums a plain address without touching RPC", async () => {
    assert.equal(await resolveAddressOrName(ADDR_LOWER), getAddress(ADDR_LOWER));
    assert.equal(await resolveAddressOrName(` ${ADDR} `), ADDR);
  });

  it("refuses to forward a typo as an address", async () => {
    await assert.rejects(
      () => resolveAddressOrName("not-an-address"),
      /not a valid Ethereum address/
    );
    await assert.rejects(
      () => resolveAddressOrName("alice"),
      /must end with \.eth, \.gwei, or \.wei/
    );
  });

  it("does not fall back to a public RPC when resolving a name without rpcUrl", async () => {
    await assert.rejects(
      () => resolveAddressOrName("alice.eth"),
      /requires an RPC URL/
    );
  });
});

describe("maybeResolveName", () => {
  it("marks a plain address as not resolved-from-name", async () => {
    assert.deepEqual(await maybeResolveName(ADDR), { address: ADDR });
  });
});
