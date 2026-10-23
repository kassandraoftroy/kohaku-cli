import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";

import { manageSpinner, type QuietSpinner } from "../src/utils/cli-quiet.js";
import {
  clearTerminalOwner,
  takeTerminal,
} from "../src/utils/progress-terminal.js";
import { startProgressRenderer } from "../src/utils/sync-progress-renderer.js";

type Call = { op: string; msg?: string };

function fakeSpinner(): { spin: QuietSpinner; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    spin: {
      start: (msg?: string) => calls.push({ op: "start", msg }),
      stop: (msg?: string) => calls.push({ op: "stop", msg }),
      message: (msg?: string) => calls.push({ op: "message", msg }),
    },
  };
}

describe("terminal ownership", () => {
  it("suspends the active spinner and restores its last message", () => {
    const { spin, calls } = fakeSpinner();
    const managed = manageSpinner(spin, false);
    managed.start("Loading balances...");
    managed.message?.("Railgun sync · 3 req");

    const restore = takeTerminal();
    assert.ok(restore, "an active spinner should hand over the line");
    assert.equal(managed.active, false, "spinner must stop drawing");
    assert.deepEqual(calls.at(-1), { op: "stop", msg: "" });

    restore();
    assert.equal(managed.active, true);
    assert.deepEqual(
      calls.at(-1),
      { op: "start", msg: "Railgun sync · 3 req" },
      "restores the message it was last showing"
    );

    managed.stop("done");
  });

  it("reports no owner once the spinner has stopped", () => {
    const { spin } = fakeSpinner();
    const managed = manageSpinner(spin, false);
    managed.start("working");
    managed.stop("done");
    assert.equal(takeTerminal(), null);
  });

  it("never takes the terminal in quiet mode", () => {
    const { spin, calls } = fakeSpinner();
    const managed = manageSpinner(spin, true);
    managed.start("Loading balances...");
    assert.equal(takeTerminal(), null);
    assert.deepEqual(calls, [], "quiet mode must not touch the terminal");
  });
});

describe("worker progress renderer", () => {
  it("declines to render when nothing owns the terminal line", () => {
    const { spin } = fakeSpinner();
    const managed = manageSpinner(spin, false);
    managed.start("held");
    clearTerminalOwner(managed);

    assert.equal(
      startProgressRenderer(
        { header: "Railgun first sync", firstRun: false, rows: [] },
        Date.now()
      ),
      null
    );
    managed.stop("done");
  });

  it("declines to render when explicitly disabled", () => {
    const { spin } = fakeSpinner();
    const managed = manageSpinner(spin, false);
    managed.start("held");

    const prev = process.env.KOHAKU_NO_WORKER_PROGRESS;
    process.env.KOHAKU_NO_WORKER_PROGRESS = "1";
    try {
      assert.equal(
        startProgressRenderer(
          { header: "Railgun first sync", firstRun: false, rows: [] },
          Date.now()
        ),
        null
      );
      assert.equal(managed.active, true, "the spinner keeps the line");
    } finally {
      if (prev === undefined) delete process.env.KOHAKU_NO_WORKER_PROGRESS;
      else process.env.KOHAKU_NO_WORKER_PROGRESS = prev;
      managed.stop("done");
    }
  });
});


it("renders task speed and ETA from the actual worker", () => {
  const result = spawnSync(process.execPath, ["--import", "tsx", "--eval", `
    (async () => {
      const { manageSpinner } = await import("./src/utils/cli-quiet.ts");
      const { startProgressRenderer } = await import("./src/utils/sync-progress-renderer.ts");
      Object.defineProperty(process.stdout, "isTTY", { value: true });
      const spinner = manageSpinner({ start() {}, stop() {}, message() {} }, false);
      spinner.start("sync");
      const renderer = startProgressRenderer({
        header: "Railgun sync", firstRun: false,
        rows: [{ label: "RPC test", done: 450, total: 1350, suffix: "450/1350 blocks",
          unit: "blocks", samples: 3, startedAt: Date.now() - 5000, updatedAt: Date.now() }],
      }, Date.now() - 5000);
      await new Promise(resolve => setTimeout(resolve, 800));
      renderer?.stop();
      spinner.stop("done");
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `], {
    cwd: new URL("..", import.meta.url), encoding: "utf8", timeout: 10000,
    env: { ...process.env, KOHAKU_NO_WORKER_PROGRESS: "0" },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /RPC test · 33% · [\d,]+ blocks\/s · task ETA ~/);
  assert.match(result.stdout, /450\/1350 blocks/);
});
