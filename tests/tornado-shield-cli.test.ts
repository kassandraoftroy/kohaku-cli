import assert from "node:assert/strict";
import { it } from "node:test";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { writeSeedKeystore } from "../src/utils/mnemonic.js";
import { writeWalletType } from "../src/utils/wallets-util.js";
const cli = fileURLToPath(new URL("../src/index.ts", import.meta.url));

it("CLI rejects restricted or multi-UserOp plans before SDK preparation, and parses repeated exclusions", async () => {
  const methods: string[] = [];
  const server = createServer((req, res) => {
    let body = ""; req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      const parsed = JSON.parse(body);
      const reply = (item: { id: number; method: string }) => {
        methods.push(item.method);
        return { jsonrpc: "2.0", id: item.id, ...(item.method === "eth_chainId" ? { result: "0x1" } : { error: { code: -32601, message: "Unexpected RPC before packing validation" } }) };
      };
      res.setHeader("content-type", "application/json"); res.end(JSON.stringify(Array.isArray(parsed) ? parsed.map(reply) : reply(parsed)));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const dir = mkdtempSync(join(tmpdir(), "kohaku-shield-cli-"));
  const walletDir = join(dir, "test");
  try {
    writeSeedKeystore("test test test test test test test test test test test junk", "password", walletDir);
    writeWalletType("mainnet", walletDir);
    const address = server.address() as { port: number };
    const cases = [
      { flags: ["--amount-formatted", "1.5", "--exclude-denomination", "0.3", "--disallow-multiple-userops"], error: /five deposit notes/ },
      { flags: ["--amount-formatted", "3.3", "--exclude-denomination", "3", "--exclude-denomination", "0.3", "--disallow-multiple-userops"], error: /five deposit notes/ },
      { flags: ["--amount-formatted", "0.02", "--exclude-denomination", "0.01"], error: /No exact Tornado packing/ },
      { flags: ["--amount-formatted", "1", "--exclude-denomination", "0.2"], error: /not a supported denomination/ },
    ];
    for (const { flags, error } of cases) {
      const result = await new Promise<{ code: number | null; text: string }>((resolve, reject) => {
        const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
        const child = spawn(process.execPath, ["--import", "tsx", cli, "shield", "--protocol", "tornado", "--non-interactive", "--without-tor",
          "--wallet", "test", "--password", "password", "--dataDir", dir, "--rpc-url", `http://127.0.0.1:${address.port}`, "--from", "0", ...flags], { env });
        let text = ""; child.stdout.on("data", (chunk) => { text += chunk; }); child.stderr.on("data", (chunk) => { text += chunk; });
        const timeout = setTimeout(() => { child.kill(); reject(new Error("CLI did not stop before SDK preparation")); }, 15_000);
        child.on("error", reject); child.on("close", (code) => { clearTimeout(timeout); resolve({ code, text }); });
      });
      assert.equal(result.code, 1, result.text); assert.match(result.text, error);
      assert.equal(existsSync(join(walletDir, "shield-runs")), false);
      assert.equal(existsSync(join(walletDir, "tc-storage.json")), false);
    }
    assert.ok(methods.length > 0);
    assert.ok(methods.every((method) => method === "eth_chainId"), methods.join(","));
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
