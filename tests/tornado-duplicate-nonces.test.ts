import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { it } from "node:test";

it("installed Tornado SDK discovers, totals, selects and re-derives old duplicate-nonce notes independently", async () => {
  const fixture = fileURLToPath(new URL("./fixtures/tornado-duplicate-nonces.ts", import.meta.url));
  const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
    const child = spawn(process.execPath, ["--import", "tsx", fixture], { env });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    const timeout = setTimeout(() => { child.kill(); reject(new Error(`Duplicate-nonce SDK regression timed out: ${output}`)); }, 30_000);
    child.on("error", (error) => { clearTimeout(timeout); reject(error); });
    child.on("close", (code) => { clearTimeout(timeout); resolve({ code, output }); });
  });
  assert.equal(result.code, 0, result.output);
});
