import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { encodeWebsiteContenthash } from "../src/lib/names/contenthash.js";

describe("encodeWebsiteContenthash", () => {
  it("encodes a CIDv0 ipfs:// URI as an ENSIP-7 contenthash", () => {
    const encoded = encodeWebsiteContenthash(
      "ipfs://QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG"
    );
    assert.ok(encoded.startsWith("0xe3"));
    assert.equal(encoded, encodeWebsiteContenthash(
      "ipfs://QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG/"
    ));
  });

  it("rejects an ipfs URI with a path", () => {
    assert.throws(
      () =>
        encodeWebsiteContenthash(
          "ipfs://QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG/index.html"
        ),
      /must be a CID without a path/
    );
  });

  it("encodes a 32-byte Swarm reference", () => {
    const hash = "aa".repeat(32);
    assert.equal(encodeWebsiteContenthash(`bzz://${hash}`), `0xe40101fa011b20${hash}`);
  });

  it("rejects missing prefixes and unsupported CIDs", () => {
    assert.throws(
      () => encodeWebsiteContenthash("https://example.com"),
      /ipfs:\/\/ or bzz:\/\//
    );
    assert.throws(
      () => encodeWebsiteContenthash("ipfs://hello"),
      /Unsupported CID format/
    );
    assert.throws(
      () => encodeWebsiteContenthash("bzz://abcd"),
      /Invalid Swarm reference/
    );
  });
});
