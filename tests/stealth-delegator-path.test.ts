import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  STEALTH_ADDRESS_MAGIC_VALUE,
  STEALTH_ADDRESS_MAGIC_VALUE_PATH,
  STEALTH_SPENDING_PATH,
  STEALTH_VIEWING_PATH,
  parseStealthDelegatorPath,
  stealthDelegatorPath,
} from "../src/lib/stealth/constants.js";
import { publicAccountDerivationPath } from "../src/utils/public-accounts.js";

describe("stealthDelegatorPath", () => {
  it("encodes s0 under the 9981' sentinel", () => {
    assert.equal(STEALTH_ADDRESS_MAGIC_VALUE, 9981);
    assert.equal(
      STEALTH_ADDRESS_MAGIC_VALUE_PATH,
      "m/44'/60'/0'/5564'/9981'"
    );
    assert.equal(stealthDelegatorPath(0), "m/44'/60'/0'/5564'/9981'/0");
    assert.equal(stealthDelegatorPath(1), "m/44'/60'/0'/5564'/9981'/1");
  });

  it("rejects invalid indexes", () => {
    assert.throws(() => stealthDelegatorPath(-1));
    assert.throws(() => stealthDelegatorPath(1.5));
  });
});

describe("parseStealthDelegatorPath", () => {
  it("round-trips stealthDelegatorPath", () => {
    assert.equal(parseStealthDelegatorPath(stealthDelegatorPath(0)), 0);
    assert.equal(parseStealthDelegatorPath(stealthDelegatorPath(12)), 12);
  });

  it("rejects public HD, stealth meta keys, and tornado-like paths", () => {
    assert.equal(parseStealthDelegatorPath(publicAccountDerivationPath(0)), null);
    assert.equal(parseStealthDelegatorPath(STEALTH_SPENDING_PATH), null);
    assert.equal(parseStealthDelegatorPath(STEALTH_VIEWING_PATH), null);
    assert.equal(parseStealthDelegatorPath("m/44'/60'/0'/5564'/2'/0"), null);
    assert.equal(parseStealthDelegatorPath("m/29795'/1'/0'/0'/0'"), null);
    assert.equal(
      parseStealthDelegatorPath(`${STEALTH_ADDRESS_MAGIC_VALUE_PATH}/0/1`),
      null
    );
    assert.equal(
      parseStealthDelegatorPath(`${STEALTH_ADDRESS_MAGIC_VALUE_PATH}/0'`),
      null
    );
    assert.equal(parseStealthDelegatorPath(STEALTH_ADDRESS_MAGIC_VALUE_PATH), null);
  });
});
