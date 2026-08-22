import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { keccak256, toBytes } from "viem";
import { namehash } from "viem/ens";

import { GNS_CONTRACT, GWEI_NODE, ONE_YEAR_SECONDS, WNS_CONTRACT } from "../src/lib/names/constants.js";
import {
  parseTransferRole,
  requiredAddressForRecords,
  requiredAddressForTransfer,
} from "../src/lib/names/ownership.js";
import {
  defaultDurationSeconds,
  ensLabelTokenId,
  nftContract,
  nftParentId,
} from "../src/lib/names/ops.js";
import type { NameOwnership } from "../src/lib/names/types.js";

const OWNERSHIP: NameOwnership = {
  owner: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
  manager: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  wrapped: false,
  node: "0x01",
};

describe("parseTransferRole", () => {
  it("defaults to both and rejects unknown roles", () => {
    assert.equal(parseTransferRole(undefined), "both");
    assert.equal(parseTransferRole(" OWNER "), "owner");
    assert.equal(parseTransferRole("manager"), "manager");
    assert.throws(() => parseTransferRole("admin"), /must be owner, manager, or both/);
  });
});

describe("requiredAddressForTransfer / records", () => {
  it("picks the owner unless the role is manager-only; records always need the manager", () => {
    assert.equal(requiredAddressForTransfer(OWNERSHIP, "owner"), OWNERSHIP.owner);
    assert.equal(requiredAddressForTransfer(OWNERSHIP, "both"), OWNERSHIP.owner);
    assert.equal(
      requiredAddressForTransfer(OWNERSHIP, "manager"),
      OWNERSHIP.manager
    );
    assert.equal(requiredAddressForRecords(OWNERSHIP), OWNERSHIP.manager);
  });
});

describe("ensLabelTokenId", () => {
  it("is keccak256(label bytes), not the namehash of the full name", () => {
    assert.equal(ensLabelTokenId("vitalik"), BigInt(keccak256(toBytes("vitalik"))));
    assert.notEqual(ensLabelTokenId("vitalik"), BigInt(namehash("vitalik.eth")));
    assert.notEqual(ensLabelTokenId("vitalik"), BigInt(namehash("vitalik")));
  });
});

describe("nftParentId", () => {
  it("is 0 for top-level .gwei/.wei, not the TLD namehash", () => {
    assert.equal(nftParentId("gns"), 0n);
    assert.equal(nftParentId("wns"), 0n);
    assert.notEqual(nftParentId("gns"), BigInt(GWEI_NODE));
  });
});

describe("nftContract", () => {
  it("maps gns/wns onto the canonical NFT addresses", () => {
    assert.equal(nftContract("gns"), GNS_CONTRACT);
    assert.equal(nftContract("wns"), WNS_CONTRACT);
  });
});

describe("defaultDurationSeconds", () => {
  it("defaults to one year and rejects non-integer years", () => {
    assert.equal(defaultDurationSeconds(undefined), ONE_YEAR_SECONDS);
    assert.equal(defaultDurationSeconds(2), 2n * ONE_YEAR_SECONDS);
    assert.throws(() => defaultDurationSeconds(0), /positive integer/);
    assert.throws(() => defaultDurationSeconds(1.5), /positive integer/);
  });
});
