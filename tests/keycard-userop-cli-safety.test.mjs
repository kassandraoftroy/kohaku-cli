import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));

const a = "0x1111111111111111111111111111111111111111";
const b = "0x2222222222222222222222222222222222222222";

const base = [
  "transact-raw",
  "--signer", "keycard",
  "--keycard-userop",
  "--targets", `${a},${b}`,
  "--payloads", "0x,0x",
  "--values", "0,0",
  "--chain-id", "31337",
  "--nonce", "0",
  "--call-gas-limit", "100000",
  "--verification-gas-limit", "200000",
  "--pre-verification-gas", "40000",
  "--max-fee-per-gas", "1000000000",
  "--max-priority-fee-per-gas", "100000000",
  "--non-interactive",
];

function run(args) {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", entry, ...args],
    {
      cwd: root,
      encoding: "utf8",
      timeout: 20000,
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

function replaceFlag(args, flag, value) {
  const copy = [...args];
  const index = copy.indexOf(flag);
  assert.notEqual(index, -1);
  copy[index + 1] = value;
  return copy;
}

test("rejects Keycard UserOperation broadcasting", () => {
  assert.match(
    run([...base, "--broadcast"]),
    /Keycard broadcasting is disabled/,
  );
});

test("rejects UserOperation mode with software signer", () => {
  assert.match(
    run(replaceFlag(base, "--signer", "software")),
    /--keycard-userop requires --signer keycard/,
  );
});

test("requires at least two calls", () => {
  let args = replaceFlag(base, "--targets", a);
  args = replaceFlag(args, "--payloads", "0x");
  args = replaceFlag(args, "--values", "0");

  assert.match(
    run(args),
    /requires at least two calls/,
  );
});

test("requires explicit UserOperation gas", () => {
  const args = [...base];
  args.splice(args.indexOf("--call-gas-limit"), 2);

  assert.match(
    run(args),
    /--call-gas-limit requires an unsigned integer/,
  );
});

test("rejects EOA gas flag in UserOperation mode", () => {
  assert.match(
    run([...base, "--gas", "21000"]),
    /Use --call-gas-limit instead of --gas/,
  );
});
