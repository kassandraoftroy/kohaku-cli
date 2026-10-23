import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { it } from "node:test";

import { clearProgressBlock, layoutProgressBlock } from "../src/utils/sync-progress-renderer.js";
import { VirtualTerminal } from "./helpers/virtual-terminal.js";

it("reproduces saved cursor headers leaking into scrollback", () => {
  const terminal = new VirtualTerminal(80, 6);
  terminal.write("\x1b7");
  for (let frame = 0; frame < 5; frame++) {
    terminal.write("\x1b8\r\x1b[JRailgun sync\r\nRPC sync\r\n[bar]");
  }
  assert.ok((terminal.text.match(/Railgun sync/g) ?? []).length > 1);
});

it("redraws one block at the bottom as tasks appear and disappear", () => {
  const terminal = new VirtualTerminal(60, 6);
  let height = 0;
  for (const count of [0, 1, 4, 2, 0, 4, 1]) {
    const lines = ["Railgun first sync · 52s · first run can take several minutes"];
    for (let i = 0; i < count; i++) {
      lines.push(`RPC task ${i} · ${"long label ".repeat(10)}`, "[████░░░░░░░░░░░░] 5670/411953 blocks");
    }
    const block = layoutProgressBlock(lines, 60, 6);
    terminal.write(clearProgressBlock(height) + block.join("\r\n"));
    height = block.length;
    assert.equal((terminal.text.match(/Railgun first sync/g) ?? []).length, 1, terminal.text);
    assert.ok(block.every((line) => Array.from(line).length < 60));
    assert.ok(block.length < 6);
  }
  terminal.write(clearProgressBlock(height));
  assert.doesNotMatch(terminal.text, /Railgun|RPC task|5670/);
});

it("actual worker leaves no repeated headers after scrolling and task changes", () => {
  const result = spawnSync(process.execPath, ["--import", "tsx", "--eval", `
    (async () => {
      const { setTerminalOwner } = await import("./src/utils/progress-terminal.ts");
      const { startProgressRenderer } = await import("./src/utils/sync-progress-renderer.ts");
      Object.defineProperties(process.stdout, {
        isTTY: { value: true }, columns: { value: 60 }, rows: { value: 6 },
      });
      setTerminalOwner({ suspend() { return "sync"; }, resume() {} });
      const snapshot = { header: "Railgun first sync", firstRun: true, rows: [] };
      const renderer = startProgressRenderer(snapshot, Date.now() - 52000);
      const pause = () => new Promise(resolve => setTimeout(resolve, 300));
      await pause();
      renderer.update({ ...snapshot, rows: [{
        label: "RPC 0xecfcf3…3fea", done: 5670, total: 411953, suffix: "5670/411953 blocks",
        unit: "blocks", samples: 3, startedAt: Date.now() - 15000, updatedAt: Date.now(),
      }] });
      await pause();
      renderer.update(snapshot);
      await pause();
      renderer.stop();
      // Detect writes racing with terminal ownership returning to the spinner.
      process.stdout.write("SPINNER RESUMED");
      await pause();
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `], {
    cwd: new URL("..", import.meta.url), encoding: "utf8", timeout: 10000,
    env: { ...process.env, KOHAKU_NO_WORKER_PROGRESS: "0" },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Railgun first sync/);
  assert.match(result.stdout, /5670\/411953 blocks/);
  assert.ok(result.stdout.endsWith("SPINNER RESUMED"), result.stdout);
  const terminal = new VirtualTerminal(60, 6);
  terminal.write(result.stdout);
  assert.doesNotMatch(terminal.text, /Railgun first sync|5670\/411953/);
  assert.match(terminal.text, /SPINNER RESUMED/);
});
