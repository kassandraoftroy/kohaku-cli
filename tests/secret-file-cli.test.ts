import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";

import { writeSeedKeystore } from "../src/utils/mnemonic.js";
import { shouldResolveCreatePasswordFromFlags } from "../src/commands/createWallet.js";

const MNEMONIC =
  "test test test test test test test test test test test junk";
const CLI_PATH = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const REPO_DIR = dirname(dirname(CLI_PATH));

function runCli(args: string[]): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, ["--import", "tsx", CLI_PATH, ...args], {
    cwd: REPO_DIR,
    encoding: "utf-8",
    env: { ...process.env, NO_COLOR: "1" },
  });
}

function outputText(output: string | Buffer | null): string {
  if (output === null) return "";
  return typeof output === "string" ? output : output.toString("utf-8");
}

function combinedOutput(result: ReturnType<typeof spawnSync>): string {
  return `${outputText(result.stdout)}${outputText(result.stderr)}`;
}

describe("secret-file CLI wiring", () => {
  it("preserves interactive create-wallet handling for the legacy password flag", () => {
    assert.equal(
      shouldResolveCreatePasswordFromFlags({ password: "legacy-literal" }),
      false
    );
    assert.equal(
      shouldResolveCreatePasswordFromFlags({ passwordFile: "/secure/password" }),
      true
    );
    assert.equal(
      shouldResolveCreatePasswordFromFlags({
        nonInteractive: true,
        password: "legacy-literal",
      }),
      true
    );
  });

  it("rejects conflicting create/import inputs without printing their values", () => {
    const mnemonicValue = "mnemonic-value-must-not-appear";
    const mnemonicPath = "/tmp/mnemonic-path-must-not-appear";
    const result = runCli([
      "create-wallet",
      "smoke",
      "--import",
      "--mnemonic",
      mnemonicValue,
      "--mnemonic-file",
      mnemonicPath,
      "--password",
      "unused",
      "--non-interactive",
    ]);
    const output = combinedOutput(result);
    assert.equal(result.status, 1);
    assert.match(output, /cannot be used with option '--mnemonic/);
    assert.doesNotMatch(output, new RegExp(mnemonicValue));
    assert.doesNotMatch(output, new RegExp(mnemonicPath));
  });

  it("rejects a missing create/import mnemonic file without printing its path", { skip: process.platform === "win32" }, () => {
    const mnemonicPath = "/tmp/missing-mnemonic-path-must-not-appear";
    const result = runCli([
      "create-wallet",
      "smoke",
      "--import",
      "--mnemonic-file",
      mnemonicPath,
      "--password",
      "unused",
      "--non-interactive",
    ]);
    const output = combinedOutput(result);
    assert.equal(result.status, 1);
    assert.match(output, /Unable to securely open mnemonic file/);
    assert.doesNotMatch(output, new RegExp(mnemonicPath));
  });

  it("unlocks an existing wallet command through --password-file", { skip: process.platform === "win32" }, () => {
    const dataDir = mkdtempSync(join(tmpdir(), "kohaku-secret-cli-"));
    const walletDir = join(dataDir, "smoke");
    const passwordPath = join(dataDir, "password");
    try {
      mkdirSync(walletDir, { recursive: true });
      writeSeedKeystore(MNEMONIC, "file-password", walletDir);
      writeFileSync(passwordPath, "file-password\n", { mode: 0o600 });
      chmodSync(passwordPath, 0o600);

      const result = runCli([
        "reveal-seed-phrase",
        "--wallet",
        "smoke",
        "--password-file",
        passwordPath,
        "--non-interactive",
        "--dataDir",
        dataDir,
      ]);
      assert.equal(result.status, 0, combinedOutput(result));
      assert.equal(outputText(result.stdout).trim(), MNEMONIC);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
