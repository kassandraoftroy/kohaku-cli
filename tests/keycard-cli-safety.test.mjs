import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));

const base = [
  "transact-raw",
  "--signer", "keycard",
  "--targets", "0x1111111111111111111111111111111111111111",
  "--payloads", "0x",
  "--values", "0",
  "--nonce", "0",
  "--gas", "21000",
  "--max-fee-per-gas", "1000000000",
  "--max-priority-fee-per-gas", "100000000",
  "--non-interactive",
];

function runCli(args) {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", entry, ...args],
    {
      cwd: root,
      encoding: "utf8",
      timeout: 15000,
      env: {
        ...process.env,
        KEYCARD_PIN: "",
        KOHAKU_KEYCARD_CLI: "/nonexistent/keycard",
      },
    },
  );

  assert.ifError(result.error);
  return `${result.stdout}\n${result.stderr}`;
}

test("rejects broadcasting with Keycard", () => {
  const output = runCli([...base, "--broadcast"]);
  assert.match(output, /Keycard broadcasting is disabled/);
});

test("rejects software wallet options", () => {
  const output = runCli([...base, "--wallet", "test-wallet"]);
  assert.match(output, /Offline Keycard signing does not use wallet/);
});

test("rejects missing chain ID", () => {
  const output = runCli(base);
  assert.match(output, /--chain-id requires an unsigned integer/);
});

test("rejects unknown signer backends", () => {
  const output = runCli([
    ...base,
    "--signer", "unknown",
  ]);
  assert.match(output, /Unknown --signer backend/);
});
