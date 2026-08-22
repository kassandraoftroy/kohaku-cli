import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  categorizeUrl,
  isLocalEntry,
  redactUrl,
  type NetworkTrafficEntry,
} from "../src/utils/network-traffic-log.js";

function entry(
  overrides: Partial<NetworkTrafficEntry> & Pick<NetworkTrafficEntry, "url">
): NetworkTrafficEntry {
  return {
    ts: "2026-01-01T00:00:00.000Z",
    kind: "http",
    method: "GET",
    host: "example.com",
    via: "clearnet",
    category: "other",
    ...overrides,
  };
}

describe("redactUrl", () => {
  it("redacts Infura-style /v3/<key> path segments", () => {
    const redacted = redactUrl("https://mainnet.infura.io/v3/abcd1234efgh5678");
    assert.equal(redacted.includes("abcd1234efgh5678"), false);
    assert.match(redacted, /v3\/(?:<redacted>|%3Credacted%3E)/);
  });

  it("does not redact keyless Pimlico /v2/<chainId>/rpc URLs", () => {
    const url = "https://public.pimlico.io/v2/1/rpc";
    assert.equal(redactUrl(url), url);
  });

  it("redacts apikey-style query params", () => {
    const redacted = redactUrl("https://eth.example/rpc?apikey=supersecret");
    assert.equal(redacted.includes("supersecret"), false);
    assert.match(redacted, /apikey=(?:<redacted>|%3Credacted%3E)/);
  });

  it("leaves localhost RPC URLs intact", () => {
    const url = "http://127.0.0.1:8545/v3/notakeybecauseitslocal";
    assert.equal(redactUrl(url), url);
  });
});

describe("categorizeUrl", () => {
  it("classifies known kohaku backends", () => {
    assert.equal(categorizeUrl("https://public.pimlico.io/v2/1/rpc"), "pimlico");
    assert.equal(
      categorizeUrl("https://saga.gordosoluciones.xyz/foo"),
      "saga"
    );
    assert.equal(
      categorizeUrl("https://artifacts.0000000000.org/railgun/01x01/wasm.br"),
      "artifacts"
    );
    assert.equal(categorizeUrl("https://example.com/foo"), "other");
  });
});

describe("isLocalEntry", () => {
  it("treats loopback and local-artifact reasons as local", () => {
    assert.equal(
      isLocalEntry(
        entry({ url: "https://example.com", clearnetReason: "loopback" })
      ),
      true
    );
    assert.equal(
      isLocalEntry(
        entry({
          url: "https://artifacts.0000000000.org/x",
          clearnetReason: "local-artifact",
        })
      ),
      true
    );
    assert.equal(
      isLocalEntry(entry({ url: "http://localhost:8545" })),
      true
    );
    assert.equal(
      isLocalEntry(entry({ url: "https://public.pimlico.io/v2/1/rpc" })),
      false
    );
  });
});
