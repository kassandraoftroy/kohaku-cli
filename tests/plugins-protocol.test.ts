import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import {
  parseIncludeProtocols,
  pluginIdForProtocol,
  resolveDefaultPrivacyProtocol,
  resolveIncludeProtocols,
  resolveProtocolOption,
  shouldIncludeProtocol,
} from "../src/utils/plugins.js";

const ORIG_DEFAULT = process.env.DEFAULT_PRIVACY_PROTOCOL;

afterEach(() => {
  if (ORIG_DEFAULT === undefined) {
    delete process.env.DEFAULT_PRIVACY_PROTOCOL;
  } else {
    process.env.DEFAULT_PRIVACY_PROTOCOL = ORIG_DEFAULT;
  }
});

describe("resolveProtocolOption", () => {
  it("prefers the flag over the env default", () => {
    process.env.DEFAULT_PRIVACY_PROTOCOL = "railgun";
    assert.deepEqual(resolveProtocolOption("tornado"), {
      ok: true,
      protocol: "tornado",
    });
  });

  it("falls back to DEFAULT_PRIVACY_PROTOCOL", () => {
    process.env.DEFAULT_PRIVACY_PROTOCOL = "privacy-pools";
    assert.deepEqual(resolveProtocolOption(undefined), {
      ok: true,
      protocol: "privacy-pools",
    });
    assert.deepEqual(resolveProtocolOption("  "), {
      ok: true,
      protocol: "privacy-pools",
    });
  });

  it("returns invalid for an unknown flag", () => {
    assert.deepEqual(resolveProtocolOption("nope"), {
      ok: false,
      error: "invalid",
    });
  });

  it("returns missing when neither flag nor env is set", () => {
    delete process.env.DEFAULT_PRIVACY_PROTOCOL;
    assert.deepEqual(resolveProtocolOption(undefined), {
      ok: false,
      error: "missing",
    });
  });

  it("ignores a garbage env default", () => {
    process.env.DEFAULT_PRIVACY_PROTOCOL = "Railgun";
    assert.deepEqual(resolveProtocolOption(undefined), {
      ok: false,
      error: "missing",
    });
  });
});

describe("parseIncludeProtocols", () => {
  it("returns null when omitted", () => {
    assert.equal(parseIncludeProtocols(undefined), null);
    assert.equal(parseIncludeProtocols("  "), null);
  });

  it("splits on commas and whitespace and dedupes", () => {
    assert.deepEqual(parseIncludeProtocols("railgun, tornado tornado"), [
      "railgun",
      "tornado",
    ]);
  });

  it("throws on an unknown protocol or empty list after split", () => {
    assert.throws(
      () => parseIncludeProtocols("railgun,nope"),
      /Invalid protocol in --include/
    );
  });
});

describe("resolveIncludeProtocols", () => {
  it("uses --include when present, else the env default, else none", () => {
    delete process.env.DEFAULT_PRIVACY_PROTOCOL;
    assert.deepEqual(resolveIncludeProtocols(undefined), []);
    process.env.DEFAULT_PRIVACY_PROTOCOL = "tornado";
    assert.deepEqual(resolveIncludeProtocols(undefined), ["tornado"]);
    assert.deepEqual(resolveIncludeProtocols("railgun"), ["railgun"]);
  });
});

describe("shouldIncludeProtocol", () => {
  it("includes everything when the filter is null", () => {
    assert.equal(shouldIncludeProtocol("railgun", null), true);
    assert.equal(shouldIncludeProtocol("tornado", ["tornado"]), true);
    assert.equal(shouldIncludeProtocol("railgun", ["tornado"]), false);
  });
});

describe("pluginIdForProtocol", () => {
  it("maps CLI protocol names onto Host plugin ids", () => {
    assert.equal(pluginIdForProtocol("railgun"), "rg");
    assert.equal(pluginIdForProtocol("tornado"), "tc");
    assert.equal(pluginIdForProtocol("privacy-pools"), "ppv1");
  });
});

describe("resolveDefaultPrivacyProtocol", () => {
  it("only accepts exact supported ids", () => {
    delete process.env.DEFAULT_PRIVACY_PROTOCOL;
    assert.equal(resolveDefaultPrivacyProtocol(), undefined);
    process.env.DEFAULT_PRIVACY_PROTOCOL = "railgun";
    assert.equal(resolveDefaultPrivacyProtocol(), "railgun");
    process.env.DEFAULT_PRIVACY_PROTOCOL = "railgun ";
    assert.equal(resolveDefaultPrivacyProtocol(), "railgun");
  });
});
