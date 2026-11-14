import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "node:test";
import { encodeAbiParameters } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { writeSeedKeystore } from "../src/utils/mnemonic.js";
import { writeWalletType } from "../src/utils/wallets-util.js";

const cli = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const key = `0x${"01".repeat(32)}` as const;
const external = privateKeyToAccount(key).address;
const protocols = ["railgun", "privacy-pools", "tornado"];

function env() {
  const result: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1", DEFAULT_PRIVACY_PROTOCOL: "tornado" };
  delete result.NODE_TEST_CONTEXT;
  delete result.RPC_URL;
  return result;
}

function run(args: string[]) {
  const result = spawnSync(process.execPath, ["--import", "tsx", cli, ...args, "--non-interactive"],
    { encoding: "utf8", env: env(), timeout: 15_000 });
  assert.equal(result.error, undefined);
  return { code: result.status, text: result.stdout + result.stderr };
}

function runAsync(args: string[]): Promise<{ code: number | null; text: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", cli, ...args, "--non-interactive", "--without-tor"], { env: env() });
    let text = "";
    child.stdout.on("data", (chunk) => { text += chunk; });
    child.stderr.on("data", (chunk) => { text += chunk; });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`CLI timed out: ${text}`)); }, 15_000);
    child.on("error", reject);
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, text }); });
  });
}

it("each protocol destination uses shield validation and explicit destinations override the default", () => {
  for (const protocol of protocols) {
    for (const flags of [
      ["--amount-wei", "1", "--amount-max"],
      ["--broadcast", "--skip-sim"],
      ["--amount-formatted", "0.02"],
    ]) {
      const direct = run(["shield", "--protocol", protocol, "--from", "0", ...flags]);
      const alias = run(["transfer", "--to", ` ${protocol} `, "--from", "0", ...flags]);
      assert.equal(alias.code, 1, alias.text);
      assert.deepEqual(alias, direct);
    }
  }
});

it("rejects protocol-to-protocol transfers and incompatible options before wallet access", () => {
  for (const from of protocols) {
    for (const to of protocols) {
      const result = run(["transfer", "--from", from, "--to", to]);
      assert.equal(result.code, 1);
      assert.match(result.text, /Protocol-to-protocol transfers are not supported/);
    }
  }
  const stealth = run(["transfer", "--to", "railgun", "--stealth"]);
  assert.match(stealth.text, /--stealth requires a public recipient/);
  for (const protocol of ["railgun", "privacy-pools"]) {
    const result = run(["transfer", "--to", protocol, "--exclude-new-pools"]);
    assert.match(result.text, /only supported with --protocol tornado/);
  }
  for (const flags of [
    ["--skip-sim"], ["--exclude-denomination", "0.01"], ["--disallow-multiple-userops"],
    ["--base-fee-gwei", "1"], ["--priority-fee-gwei", "1"],
  ]) {
    const result = run(["transfer", "--from", "0", "--to", external, ...flags]);
    assert.equal(result.code, 1);
    assert.match(result.text, /requires --to <protocol>/);
  }
});

it("external shield senders require a matching key for broadcast and accept non-denomination PPv1/Railgun amounts", async () => {
  const methods: string[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      const parsed = JSON.parse(body);
      const reply = (item: { id: number; method: string }) => {
        methods.push(item.method);
        const result = item.method === "eth_chainId" ? "0x1" :
          item.method === "eth_getBalance" ? "0xde0b6b3a7640000" :
          item.method === "eth_call" ? encodeAbiParameters(
            [{ type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }],
            ["0x1111111111111111111111111111111111111111", 1n, 0n, 100n]) : undefined;
        return { jsonrpc: "2.0", id: item.id, ...(result !== undefined ? { result } :
          { error: { code: -32601, message: "Unexpected RPC after sender resolution" } }) };
      };
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(Array.isArray(parsed) ? parsed.map(reply) : reply(parsed)));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const dataDir = mkdtempSync(join(tmpdir(), "kohaku-transfer-shield-"));
  const walletDir = join(dataDir, "test");
  try {
    writeSeedKeystore("test test test test test test test test test test test junk", "password", walletDir);
    writeWalletType("mainnet", walletDir);
    const before = readdirSync(walletDir).sort();
    const { port } = server.address() as { port: number };
    const base = ["transfer", "--from", external, "--wallet", "test", "--password", "password",
      "--dataDir", dataDir, "--rpc-url", `http://127.0.0.1:${port}`, "--broadcast"];
    for (const protocol of protocols) {
      const amount = protocol === "tornado" ? "0.02" : "0.012345678901234567";
      const missing = await runAsync([...base, "--to", protocol, "--amount-formatted", amount]);
      assert.equal(missing.code, 1, missing.text);
      assert.match(missing.text, /No stored key for --from.*--sender-priv/);
      const wrong = await runAsync([...base, "--to", protocol, "--amount-formatted", amount,
        "--sender-priv", `0x${"02".repeat(32)}`]);
      assert.equal(wrong.code, 1, wrong.text);
      assert.match(wrong.text, /Sender private key does not match/);
      assert.doesNotMatch(wrong.text, /0202020202020202/);
    }
    assert.deepEqual(readdirSync(walletDir).sort(), before);
    assert.ok(methods.every((method) => ["eth_chainId", "eth_getBalance", "eth_call"].includes(method)), methods.join(","));
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
