import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import {
  DEFAULT_ARTIFACTS_BASE_URL,
  artifactRelativeKeyFromUrl,
  listAllArtifactRelativeKeys,
  parseFetchArtifactSelection,
  railgunTransactVariants,
} from "../src/utils/proving-artifacts.js";

const ORIG_BASE = process.env.KOHAKU_ARTIFACTS_BASE_URL;

afterEach(() => {
  if (ORIG_BASE === undefined) {
    delete process.env.KOHAKU_ARTIFACTS_BASE_URL;
  } else {
    process.env.KOHAKU_ARTIFACTS_BASE_URL = ORIG_BASE;
  }
});

const MACWHA =
  "https://github.com/Robert-MacWha/privacy-protocol-artifacts/raw/refs/heads/main/artifacts";
const TORNADO_JSON =
  "https://raw.githubusercontent.com/tornadocash/tornado-cli/refs/heads/master/build/circuits/tornado.json";
const TORNADO_KEY =
  "https://raw.githubusercontent.com/tornadocash/tornado-cli/refs/heads/master/build/circuits/tornadoProvingKey.bin";

describe("railgunTransactVariants", () => {
  it("covers the 01x01…05x05 transact grid", () => {
    const v = railgunTransactVariants();
    assert.equal(v.length, 25);
    assert.equal(v[0], "01x01");
    assert.equal(v.at(-1), "05x05");
  });
});

describe("parseFetchArtifactSelection", () => {
  it("returns the full set when no filters are given", () => {
    const all = listAllArtifactRelativeKeys();
    assert.deepEqual(parseFetchArtifactSelection({}), all);
    assert.ok(all.includes("tornado/tornado.json"));
    assert.ok(all.includes("railgun/01x01/proving_key.bin.br"));
    assert.ok(all.includes("railgun/poi/03x03/wasm.br"));
  });

  it("unions explicit keys, variants, and tornado", () => {
    const keys = parseFetchArtifactSelection({
      keys: ["railgun/01x01/wasm.br"],
      variants: ["01x02"],
      tornado: true,
    });
    assert.ok(keys.includes("railgun/01x01/wasm.br"));
    assert.ok(keys.includes("railgun/01x02/proving_key.bin.br"));
    assert.ok(keys.includes("tornado/tornado.json"));
    assert.ok(keys.includes("tornado/tornadoProvingKey.bin"));
  });

  it("rejects an unknown key or variant", () => {
    assert.throws(
      () => parseFetchArtifactSelection({ keys: ["nope.bin"] }),
      /Unknown artifact key/
    );
    assert.throws(
      () => parseFetchArtifactSelection({ variants: ["99x99"] }),
      /Unknown Railgun transact variant/
    );
    assert.throws(
      () => parseFetchArtifactSelection({ poi: ["01x01"] }),
      /Unknown Railgun POI variant/
    );
  });
});

describe("artifactRelativeKeyFromUrl", () => {
  it("maps MacWha artifact URLs onto cache-relative paths", () => {
    assert.equal(
      artifactRelativeKeyFromUrl(`${MACWHA}/01x01/proving_key.bin.br`),
      "01x01/proving_key.bin.br"
    );
  });

  it("maps Tornado GitHub circuit URLs", () => {
    assert.equal(artifactRelativeKeyFromUrl(TORNADO_JSON), "tornado/tornado.json");
    assert.equal(
      artifactRelativeKeyFromUrl(TORNADO_KEY),
      "tornado/tornadoProvingKey.bin"
    );
  });

  it("maps the default artifacts mirror when the env is unset", () => {
    delete process.env.KOHAKU_ARTIFACTS_BASE_URL;
    assert.equal(
      artifactRelativeKeyFromUrl(
        `${DEFAULT_ARTIFACTS_BASE_URL}/railgun/01x01/wasm.br`
      ),
      "railgun/01x01/wasm.br"
    );
  });

  it("returns null for an unrelated HTTP URL", () => {
    assert.equal(artifactRelativeKeyFromUrl("https://example.com/foo"), null);
    assert.equal(artifactRelativeKeyFromUrl("not a url"), null);
  });

  it("excludes sync-cache snapshot URLs sharing the artifacts base", () => {
    delete process.env.KOHAKU_ARTIFACTS_BASE_URL;
    // Otherwise these would inherit the artifact Tor timeout, get duplicated
    // into proving-artifacts, and pin later runs to the first snapshot fetched.
    for (const key of [
      "sync-cache/v1/manifest.json",
      "sync-cache/v1/chunk-000.tar.gz",
      "public-sync-cache.tar.gz",
    ]) {
      assert.equal(
        artifactRelativeKeyFromUrl(`${DEFAULT_ARTIFACTS_BASE_URL}/${key}`),
        null,
        `expected ${key} to be excluded`
      );
      assert.equal(
        artifactRelativeKeyFromUrl(`${MACWHA}/${key}`),
        null,
        `expected MacWha ${key} to be excluded`
      );
    }
  });
});
