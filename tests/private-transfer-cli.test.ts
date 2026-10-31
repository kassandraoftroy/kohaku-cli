import assert from "node:assert/strict";
import { spawn, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { writeSeedKeystore } from "../src/utils/mnemonic.js";
import { writeWalletType } from "../src/utils/wallets-util.js";

const MNEMONIC =
  "test test test test test test test test test test test junk";
const CLI_PATH = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const REPO_DIR = dirname(dirname(CLI_PATH));
const PAYEE = "0x1111111111111111111111111111111111111111";

function cliEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1" };
  delete env.RPC_URL;
  delete env.NODE_TEST_CONTEXT;
  return env;
}

function runCli(args: string[]): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, ["--import", "tsx", CLI_PATH, ...args], {
    cwd: REPO_DIR,
    encoding: "utf-8",
    env: cliEnv(),
    timeout: 20000,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** Async spawn so a local RPC server in this process can answer while the CLI runs. */
function runCliAsync(args: string[]): Promise<SpawnSyncReturns<string>> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", CLI_PATH, ...args], {
      cwd: REPO_DIR,
      env: cliEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
    }, 20000);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (status, signal) => {
      clearTimeout(timer);
      resolve({
        status,
        signal,
        stdout,
        stderr,
        pid: child.pid ?? 0,
        output: [null, stdout, stderr],
      });
    });
  });
}

function outputText(output: string | Buffer | null): string {
  if (output === null) return "";
  return typeof output === "string" ? output : output.toString("utf-8");
}

function combinedOutput(result: { stdout: string | Buffer | null; stderr: string | Buffer | null }): string {
  return `${outputText(result.stdout)}${outputText(result.stderr)}`;
}

function baseArgs(extra: string[]): string[] {
  return ["private-transfer", "--protocol", "tornado", "--non-interactive", ...extra];
}

function transferAliasArgs(protocol: string, extra: string[]): string[] {
  return ["transfer", "--from", protocol, "--non-interactive", ...extra];
}

function assertNoBroadcast(output: string): void {
  assert.equal(output.includes("Broadcasting private transfer"), false);
}

function listenChainId(): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      let parsed: { id?: unknown } | Array<{ id?: unknown }> = {};
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as
          | { id?: unknown }
          | Array<{ id?: unknown }>;
      } catch {
        parsed = {};
      }
      const items = Array.isArray(parsed) ? parsed : [parsed];
      const results = items.map((item) => ({
        jsonrpc: "2.0",
        id: item.id ?? null,
        result: "0x1",
      }));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(Array.isArray(parsed) ? results : results[0]));
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr == null || typeof addr === "string") {
        reject(new Error("expected a TCP port"));
        return;
      }
      resolve({ server, url: `http://127.0.0.1:${addr.port}` });
    });
  });
}

describe("private-transfer CLI wiring", () => {
  it("routes each private protocol source through private-transfer validation", () => {
    for (const protocol of ["railgun", "tornado", "privacy-pools"]) {
      const flags = ["--to", PAYEE, "--amount-wei", "1", "--amount-formatted", "0.1"];
      const direct = runCli(["private-transfer", "--protocol", protocol, "--non-interactive", ...flags]);
      const alias = runCli(transferAliasArgs(protocol, flags));
      assert.equal(direct.status, 1);
      assert.equal(alias.status, direct.status);
      assert.match(combinedOutput(alias), /Provide only one of --amount-wei or --amount-formatted/);
      assert.equal(combinedOutput(alias), combinedOutput(direct));
      assertNoBroadcast(combinedOutput(alias));
    }
  });

  it("rejects public-only transfer flags with a private source", () => {
    for (const [flag, expected] of [
      ["--from-priv", /--from-priv is only supported for public transfers/],
      ["--stealth", /--stealth is only supported for public transfers/],
      ["--amount-max", /private-transfer does not support --amount-max/],
    ] as const) {
      const result = runCli(transferAliasArgs("tornado", [flag, "--to", PAYEE]));
      assert.equal(result.status, 1);
      assert.match(combinedOutput(result), expected);
      assertNoBroadcast(combinedOutput(result));
    }
  });

  it("supports Tornado's pool option through the alias and rejects it for other sources", () => {
    const tornado = runCli(transferAliasArgs("tornado", ["--exclude-new-pools", "--to", PAYEE, "--amount-wei", "1"]));
    assert.equal(tornado.status, 1);
    assert.match(combinedOutput(tornado), /--wallet <name> is required when using --non-interactive/);

    const railgun = runCli(transferAliasArgs("railgun", ["--exclude-new-pools", "--to", PAYEE, "--amount-wei", "1"]));
    assert.equal(railgun.status, 1);
    assert.match(combinedOutput(railgun), /--exclude-new-pools is only supported with --protocol tornado/);

    const publicTransfer = runCli(["transfer", "--from", "0", "--exclude-new-pools", "--to", PAYEE, "--amount-wei", "1", "--non-interactive"]);
    assert.equal(publicTransfer.status, 1);
    assert.match(combinedOutput(publicTransfer), /--exclude-new-pools requires --from tornado/);
  });

  it("rejects both amount flags", () => {
    const result = runCli(
      baseArgs([
        "--to",
        PAYEE,
        "--amount-wei",
        "1",
        "--amount-formatted",
        "0.1",
      ])
    );
    const output = combinedOutput(result);
    assert.equal(result.status, 1);
    assert.match(output, /Provide only one of --amount-wei or --amount-formatted/);
    assertNoBroadcast(output);
  });

  it("rejects a bare --amount flag", () => {
    const result = runCli(baseArgs(["--to", PAYEE, "--amount", "0.1"]));
    const output = combinedOutput(result);
    assert.equal(result.status, 1);
    assert.match(output, /unknown option '--amount'/);
    assertNoBroadcast(output);
  });

  it("rejects --amount-max, --next, and --tail-calls before any broadcast", () => {
    for (const flag of ["--amount-max", "--next", "--tail-calls"]) {
      const args = baseArgs(["--to", PAYEE, "--amount-wei", "1", flag]);
      if (flag === "--tail-calls") args.push("0x1111111111111111111111111111111111111111:0x");
      const result = runCli(args);
      const output = combinedOutput(result);
      assert.equal(result.status, 1, output);
      assert.match(output, new RegExp(`unknown option '${flag}'`));
      assertNoBroadcast(output);
    }
  });

  it("requires --to and an amount flag in non-interactive mode", () => {
    const missingTo = runCli(baseArgs(["--amount-wei", "1"]));
    const missingToOutput = combinedOutput(missingTo);
    assert.equal(missingTo.status, 1);
    assert.match(missingToOutput, /Missing --to in non-interactive mode/);
    assertNoBroadcast(missingToOutput);

    const missingAmount = runCli(baseArgs(["--to", PAYEE]));
    const missingAmountOutput = combinedOutput(missingAmount);
    assert.equal(missingAmount.status, 1);
    assert.match(
      missingAmountOutput,
      /Missing amount in non-interactive mode\. Provide --amount-wei or --amount-formatted/
    );
    assertNoBroadcast(missingAmountOutput);
  });

  it("rejects an unknown stealth selector and a non-address recipient", async () => {
    const { server, url } = await listenChainId();
    const dataDir = mkdtempSync(join(tmpdir(), "kohaku-pt-cli-"));
    const walletDir = join(dataDir, "smoke");
    try {
      writeSeedKeystore(MNEMONIC, "file-password", walletDir);
      writeWalletType("mainnet", walletDir);
      const common = [
        "--wallet",
        "smoke",
        "--password",
        "file-password",
        "--dataDir",
        dataDir,
        "--rpc-url",
        url,
        "--without-tor",
        "--amount-formatted",
        "0.1",
      ];

      const stealth = await runCliAsync(baseArgs(["--to", "s0", ...common]));
      const stealthOutput = combinedOutput(stealth);
      assert.equal(stealth.status, 1, stealthOutput);
      assert.match(stealthOutput, /Stealth account s0 not found/);
      assertNoBroadcast(stealthOutput);

      const bad = await runCliAsync(baseArgs(["--to", "not-an-address", ...common]));
      const badOutput = combinedOutput(bad);
      assert.equal(bad.status, 1, badOutput);
      assert.match(badOutput, /is not a valid Ethereum address/);
      assertNoBroadcast(badOutput);

      const alias = await runCliAsync(transferAliasArgs("tornado", ["--to", "not-an-address", ...common]));
      const aliasOutput = combinedOutput(alias);
      assert.equal(alias.status, bad.status, aliasOutput);
      assert.match(aliasOutput, /is not a valid Ethereum address/);
      assertNoBroadcast(aliasOutput);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });
});
