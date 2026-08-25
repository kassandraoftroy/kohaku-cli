import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import {
  DEFAULT_RPC_URL,
  currentBlockRpcCandidates,
  resolveOptionalRpcUrl,
  resolveRpcUrl,
} from "../src/utils/rpc.js";

describe("resolveOptionalRpcUrl", () => {
  const prev = process.env.RPC_URL;
  afterEach(() => {
    if (prev === undefined) delete process.env.RPC_URL;
    else process.env.RPC_URL = prev;
  });

  it("returns undefined when neither flag nor env is set", () => {
    delete process.env.RPC_URL;
    assert.equal(resolveOptionalRpcUrl(undefined), undefined);
    assert.equal(resolveOptionalRpcUrl("  "), undefined);
  });

  it("prefers --rpc-url over RPC_URL", () => {
    process.env.RPC_URL = "https://from-env.example";
    assert.equal(resolveOptionalRpcUrl("https://from-flag.example"), "https://from-flag.example");
  });

  it("uses RPC_URL when the flag is omitted", () => {
    process.env.RPC_URL = "https://from-env.example";
    assert.equal(resolveOptionalRpcUrl(undefined), "https://from-env.example");
  });
});

describe("resolveRpcUrl", () => {
  const prev = process.env.RPC_URL;
  afterEach(() => {
    if (prev === undefined) delete process.env.RPC_URL;
    else process.env.RPC_URL = prev;
  });

  it("falls back to localhost only when nothing is configured", () => {
    delete process.env.RPC_URL;
    assert.equal(resolveRpcUrl(undefined), DEFAULT_RPC_URL);
  });
});

describe("currentBlockRpcCandidates", () => {
  it("does not default to localhost when no rpcUrl is provided", () => {
    const urls = currentBlockRpcCandidates({ testnet: false });
    assert.ok(urls.length >= 1);
    assert.equal(urls.some((u) => u.includes("localhost")), false);
    assert.equal(urls.some((u) => u.includes("ankr.com")), false);
  });

  it("puts an explicit rpcUrl first and still tries public fallbacks", () => {
    const preferred = "http://localhost:8545";
    const urls = currentBlockRpcCandidates({ testnet: false, rpcUrl: preferred });
    assert.equal(urls[0], preferred);
    assert.ok(urls.length > 1);
  });

  it("uses Sepolia public RPCs for testnet", () => {
    const urls = currentBlockRpcCandidates({ testnet: true });
    assert.ok(urls.every((u) => /sepolia/i.test(u)));
  });
});
