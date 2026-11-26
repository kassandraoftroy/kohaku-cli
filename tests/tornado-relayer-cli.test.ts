import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const run = (args: string[]) => {
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, ["--import", "tsx", entry, ...args, "--non-interactive"],
    { env, encoding: "utf8", timeout: 30_000 });
};

test("classic relayer CLI restrictions run before wallet access or network work", () => {
  const cases: Array<[string[], RegExp]> = [
    [["unshield", "--protocol", "tornado", "--exit-mode", "other"], /--exit-mode must be paymaster or relayer/],
    [["unshield", "--protocol", "privacy-pools", "--exit-mode", "relayer"], /--exit-mode is only supported.*tornado/],
    [["unshield", "--protocol", "tornado", "--exit-mode", "relayer", "--tail-calls", "0x1111111111111111111111111111111111111111:0x"], /do not support --tail-calls/],
    [["unshield", "--protocol", "tornado", "--exit-mode", "relayer", "--amount-max"], /explicit pool denomination/],
    [["private-transfer", "--protocol", "tornado", "--exit-mode", "relayer"], /unknown option.*--exit-mode/],
    [["transfer", "--from", "tornado", "--exit-mode", "relayer"], /unknown option.*--exit-mode/],
  ];
  for (const [args, expected] of cases) {
    const result = run(args);
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout + result.stderr, expected);
    assert.doesNotMatch(result.stdout + result.stderr, /Wallet.*not found|ECONNREFUSED|Tor ready/);
  }
});
