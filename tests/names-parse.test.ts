import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  parseManagedName,
  parseNameLabelOrFull,
  parseNameProtocol,
  parseRegisterName,
  protocolFromNameTld,
} from "../src/lib/names/parse.js";

describe("parseNameProtocol", () => {
  it("accepts ens/gns/wns case-insensitively", () => {
    assert.equal(parseNameProtocol("ENS"), "ens");
    assert.equal(parseNameProtocol("gns"), "gns");
    assert.equal(parseNameProtocol("wns"), "wns");
  });

  it("rejects a missing or unknown protocol", () => {
    assert.throws(() => parseNameProtocol(undefined), /must be one of/);
    assert.throws(() => parseNameProtocol("ensv2"), /must be one of/);
  });
});

describe("protocolFromNameTld", () => {
  it("maps supported TLDs and ignores everything else", () => {
    assert.equal(protocolFromNameTld("Alice.ETH"), "ens");
    assert.equal(protocolFromNameTld("x.gwei"), "gns");
    assert.equal(protocolFromNameTld("x.wei"), "wns");
    assert.equal(protocolFromNameTld("alice"), null);
    assert.equal(protocolFromNameTld("alice.com"), null);
  });
});

describe("parseManagedName", () => {
  it("parses a top-level name and rejects subdomains", () => {
    assert.deepEqual(parseManagedName(" Alice.ETH "), {
      label: "alice",
      protocol: "ens",
      name: "alice.eth",
    });
    assert.deepEqual(parseManagedName("Bob.gwei"), {
      label: "bob",
      protocol: "gns",
      name: "bob.gwei",
    });
    assert.throws(
      () => parseManagedName("alice.bob.eth"),
      /Only top-level names/
    );
    assert.throws(() => parseManagedName("alice"), /must end with/);
  });
});

describe("parseNameLabelOrFull", () => {
  it("treats a bare label as bare and a TLD name as full", () => {
    assert.deepEqual(parseNameLabelOrFull("alice"), {
      kind: "bare",
      label: "alice",
    });
    const full = parseNameLabelOrFull("alice.eth");
    assert.equal(full.kind, "full");
    assert.equal(full.label, "alice");
    assert.equal(full.parsed?.protocol, "ens");
  });

  it("rejects empty input and unsupported TLDs", () => {
    assert.throws(() => parseNameLabelOrFull("  "), /must not be empty/);
    assert.throws(
      () => parseNameLabelOrFull("alice.com"),
      /Unsupported TLD/
    );
  });
});

describe("parseRegisterName", () => {
  it("applies --protocol to a bare label", () => {
    assert.deepEqual(parseRegisterName("Alice", "gns"), {
      label: "alice",
      protocol: "gns",
      name: "alice.gwei",
    });
  });

  it("rejects a TLD that does not match --protocol", () => {
    assert.throws(
      () => parseRegisterName("alice.eth", "gns"),
      /is a ENS name but --protocol is gns/
    );
  });

  it("rejects subdomains even when the TLD matches", () => {
    assert.throws(
      () => parseRegisterName("alice.bob.eth", "ens"),
      /Only top-level names/
    );
  });
});
