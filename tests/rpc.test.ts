import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import {
  DEFAULT_RPC_URL,
  currentBlockRpcCandidates,
  disposePublicClient,
  makePublicClient,
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

describe("makePublicClient HTTP JSON-RPC batching", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("packs concurrent eth_getBalance calls into one batched POST", async () => {
    const posts: unknown[] = [];
    globalThis.fetch = (async (_input, init) => {
      const raw = typeof init?.body === "string" ? init.body : "";
      const parsed = JSON.parse(raw) as unknown;
      posts.push(parsed);

      if (Array.isArray(parsed)) {
        return new Response(
          JSON.stringify(
            parsed.map((req: { id: number; method: string }) => ({
              jsonrpc: "2.0",
              id: req.id,
              result: "0x1",
            }))
          ),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }

      const single = parsed as { id: number; method: string };
      if (single.method === "eth_chainId") {
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: single.id, result: "0x1" }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: single.id, result: "0x0" }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }) as typeof fetch;

    const client = await makePublicClient("http://batch-test.invalid");
    try {
      const a = "0x1111111111111111111111111111111111111111" as const;
      const b = "0x2222222222222222222222222222222222222222" as const;
      await Promise.all([
        client.getBalance({ address: a }),
        client.getBalance({ address: b }),
        client.getBalance({ address: a }),
      ]);
    } finally {
      disposePublicClient(client);
    }

    // First POST is eth_chainId (single); remaining balance reads should batch.
    assert.ok(posts.length >= 2);
    const chainIdPost = posts[0] as { method?: string };
    assert.equal(chainIdPost.method, "eth_chainId");

    const batchPosts = posts.slice(1).filter(Array.isArray) as Array<
      Array<{ method: string }>
    >;
    assert.ok(
      batchPosts.length >= 1,
      `expected at least one JSON-RPC batch array, got posts=${JSON.stringify(posts)}`
    );
    const methods = batchPosts.flat().map((r) => r.method);
    assert.equal(methods.filter((m) => m === "eth_getBalance").length, 3);
    assert.ok(
      batchPosts.some((batch) => batch.length >= 2),
      "expected multiple getBalance calls in one HTTP body"
    );
  });
});
