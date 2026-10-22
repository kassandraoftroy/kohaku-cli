import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEFAULT_ARTIFACTS_BASE_URL,
  artifactRelativeKeyFromUrl,
  listAllArtifactRelativeKeys,
  packagedArtifactsDir,
  railgunTransactVariants,
  readPackagedArtifact,
} from "../src/utils/proving-artifacts.js";

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

describe("listAllArtifactRelativeKeys", () => {
  it("includes Tornado, Railgun, and Privacy Pools keys", () => {
    const all = listAllArtifactRelativeKeys();
    assert.ok(all.includes("tornado/tornado.json"));
    assert.ok(all.includes("tornado/tornadoProvingKey.bin"));
    assert.ok(all.includes("railgun/01x01/proving_key.bin.br"));
    assert.ok(all.includes("railgun/poi/03x03/wasm.br"));
    assert.ok(
      all.includes("privacy-pools/trusted-setup/final-keys/commitment.zkey")
    );
    assert.ok(
      all.includes("privacy-pools/build/withdraw/withdraw_js/withdraw.wasm")
    );
  });
});

describe("packaged artifacts", () => {
  it("reads a circuit from the installed package without fetching", () => {
    const root = packagedArtifactsDir();
    assert.ok(root, "kohaku-artifacts is not installed");
    for (const key of listAllArtifactRelativeKeys()) {
      const body = readPackagedArtifact(key);
      assert.ok(body && body.length > 0, `missing packaged artifact ${key}`);
    }
    const circuit = readPackagedArtifact("tornado/tornado.json");
    assert.equal(circuit!.subarray(0, 1).toString(), "{");
  });
});

describe("artifactRelativeKeyFromUrl", () => {
  it("maps Railgun WASM artifact URLs onto package paths", () => {
    assert.equal(
      artifactRelativeKeyFromUrl(`${MACWHA}/railgun/01x01/proving_key.bin.br`),
      "railgun/01x01/proving_key.bin.br"
    );
    assert.equal(
      artifactRelativeKeyFromUrl(`${MACWHA}/railgun/poi/03x03/wasm.br`),
      "railgun/poi/03x03/wasm.br"
    );
  });

  it("maps Privacy Pools GitHub circuit URLs onto /privacy-pools", () => {
    const commitmentZkey =
      "https://raw.githubusercontent.com/0xbow-io/privacy-pools-core/7bc392dad5fa483f53cf74e25d7ad19f0fc6d85f/packages/circuits/trusted-setup/final-keys/commitment.zkey";
    assert.equal(
      artifactRelativeKeyFromUrl(commitmentZkey),
      "privacy-pools/trusted-setup/final-keys/commitment.zkey"
    );
    const otherCommit = commitmentZkey.replace(
      "7bc392dad5fa483f53cf74e25d7ad19f0fc6d85f",
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    );
    assert.equal(
      artifactRelativeKeyFromUrl(otherCommit),
      "privacy-pools/trusted-setup/final-keys/commitment.zkey"
    );
    assert.equal(
      artifactRelativeKeyFromUrl(
        "https://raw.githubusercontent.com/0xbow-io/privacy-pools-core/7bc392dad5fa483f53cf74e25d7ad19f0fc6d85f/packages/circuits/build/commitment/commitment_js/commitment.wasm"
      ),
      "privacy-pools/build/commitment/commitment_js/commitment.wasm"
    );
    assert.equal(
      artifactRelativeKeyFromUrl(
        "https://raw.githubusercontent.com/someone/else/main/packages/circuits/commitment.zkey"
      ),
      null
    );
  });

  it("maps Tornado GitHub circuit URLs", () => {
    assert.equal(artifactRelativeKeyFromUrl(TORNADO_JSON), "tornado/tornado.json");
    assert.equal(
      artifactRelativeKeyFromUrl(TORNADO_KEY),
      "tornado/tornadoProvingKey.bin"
    );
  });

  it("maps the artifacts mirror onto package paths", () => {
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
