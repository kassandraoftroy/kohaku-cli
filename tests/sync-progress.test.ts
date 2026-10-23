import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  addSyncUnits,
  beginSyncActivity,
  noteSyncFirstRun,
  reportSyncBlockProgress,
  runWithSyncProgress,
} from "../src/utils/sync-progress.js";

/** Progress emits are coalesced, so settle before inspecting messages. */
const settle = () => new Promise((r) => setTimeout(r, 300));
const macrotask = () => new Promise((r) => setTimeout(r, 0));

async function capture(
  opts: Parameters<typeof runWithSyncProgress>[0],
  body: () => Promise<void> | void
): Promise<string[]> {
  const messages: string[] = [];
  await runWithSyncProgress({ ...opts, onUpdate: (m) => messages.push(m) }, async () => {
    await body();
    await settle();
  });
  return messages;
}

describe("sync progress steps", () => {
  it("reports 'starting' before any step is known", async () => {
    const messages = await capture({ source: "railgun" }, () => {});
    assert.match(messages[0]!, /^Railgun sync · starting · \d+s$/, messages.join("\n"));
  });

  it("keeps independent fixed totals and clamps each ticket to its own task", async () => {
    const messages = await capture({ source: "tornado" }, async () => {
      const first = addSyncUnits("saga", 2);
      const second = addSyncUnits("saga", 3);
      first.advance(10);
      second.advance();
    });
    const last = messages.at(-1)!;
    assert.doesNotMatch(last, /Saga 2\/2 chunks/, last);
    assert.match(last, /Saga 1\/3 chunks/, last);
    assert.doesNotMatch(last, /5\/5|3\/3|10\//, last);
  });

  it("does not move done backward", async () => {
    const messages = await capture({ source: "stealth" }, () => {
      reportSyncBlockProgress(500n, 1000n);
      reportSyncBlockProgress(100n, 5000n);
    });
    const last = messages.at(-1)!;
    assert.match(last, /500\/1000 blocks/, last);
    assert.doesNotMatch(last, /100\/1000|500\/5000|100\/5000/, last);
  });

  it("does not grow denominators when another task is discovered", async () => {
    const messages = await capture({ source: "privacy-pools" }, async () => {
      const first = addSyncUnits("rpc", 4);
      first.advance();
      first.advance();
      await macrotask();
      const second = addSyncUnits("rpc", 3);
      second.advance();
    });
    const last = messages.at(-1)!;
    assert.match(last, /RPC 2\/4 windows/, last);
    assert.match(last, /RPC 1\/3 windows/, last);
    assert.doesNotMatch(last, /3\/7/, last);
  });

  it("hides the previous completed pass while the next pass is active", async () => {
    const messages = await capture({ source: "privacy-pools" }, async () => {
      const legacy = addSyncUnits("saga", 2, "Saga legacy");
      legacy.advance(2);
      await macrotask();
      const signature = addSyncUnits("saga", 4, "Saga signature");
      signature.advance();
    });
    const last = messages.at(-1)!;
    assert.match(last, /Saga signature 1\/4 chunks/, last);
    assert.doesNotMatch(last, /Saga legacy/, last);
  });

  it("ticks from outside the async-local scope while a session is open", async () => {
    const messages = await capture({ source: "tornado" }, async () => {
      await new Promise<void>((resolve) => {
        setTimeout(() => {
          const ticket = addSyncUnits("saga", 4);
          ticket.advance();
          ticket.advance();
          resolve();
        }, 0);
      });
    });
    const last = messages.at(-1)!;
    assert.match(last, /Saga 2\/4/, last);
  });

  it("keeps the non-TTY summary on one line", async () => {
    const messages = await capture({ source: "privacy-pools" }, async () => {
      const saga = addSyncUnits("saga", 12);
      const rpc = addSyncUnits("rpc", 19);
      saga.advance(4);
      rpc.advance(2);
    });
    assert.ok(messages.every((m) => !m.includes("\n")), messages.join("\n"));
    const last = messages.at(-1)!;
    assert.match(last, /^Privacy Pools sync · Saga 4\/12 chunks .*RPC 2\/19 windows .* · \d+s$/);
  });
});

describe("sync progress labels", () => {
  it("marks a first run and leaves incremental runs unmarked", async () => {
    const first = await capture({ source: "railgun", firstRun: true }, () => {});
    assert.match(first.at(-1)!, /^Railgun first sync · starting · /, first.join("\n"));

    const incremental = await capture({ source: "railgun" }, () => {});
    assert.match(incremental.at(-1)!, /^Railgun sync · starting · /, incremental.join("\n"));
    assert.doesNotMatch(incremental.at(-1)!, /first sync/, incremental.join("\n"));
  });

  it("calls the stealth source a scan and shows scanned/total blocks", async () => {
    const messages = await capture({ source: "stealth" }, () => {
      reportSyncBlockProgress(500n, 1000n);
    });
    const last = messages.at(-1)!;
    assert.match(last, /^Stealth scan · Blocks 500\/1000 blocks · 50% .* · \d+s$/, last);
    assert.doesNotMatch(last, /req/, last);
  });

  it("lets an inner scope refine the first-run label", async () => {
    const messages = await capture({ source: "stealth" }, () => {
      noteSyncFirstRun(true);
      reportSyncBlockProgress(1n, 10n);
    });
    assert.match(messages.at(-1)!, /^Stealth first scan · /, messages.join("\n"));
  });

  it("names each protocol", async () => {
    for (const [source, label] of [
      ["railgun", "Railgun"],
      ["privacy-pools", "Privacy Pools"],
      ["tornado", "Tornado Cash"],
    ] as const) {
      const messages = await capture({ source }, () => {});
      assert.match(messages[0]!, new RegExp(`^${label} sync · `));
    }
  });
});

describe("sync progress emission", () => {
  it("does not emit a prelude through onUpdate", async () => {
    const messages = await capture(
      {
        source: "stealth",
        prelude: "Stealth scan from block 25700000 · 100000 blocks",
      },
      () => {}
    );
    assert.ok(
      messages.every((m) => !m.includes("Stealth scan from block")),
      messages.join("\n")
    );
  });

  it("emits nothing when no onUpdate is provided", async () => {
    let emitted = 0;
    await runWithSyncProgress({ source: "railgun" }, async () => {
      addSyncUnits("rpc", 1).advance();
      await settle();
    });
    // Nested scopes reuse the outer store, so a nested onUpdate is ignored too.
    await runWithSyncProgress({ source: "railgun" }, async () => {
      await runWithSyncProgress(
        { source: "tornado", onUpdate: () => (emitted += 1) },
        async () => {
          addSyncUnits("rpc", 1).advance();
          await settle();
        }
      );
    });
    assert.equal(emitted, 0);
  });

  it("formats elapsed time past a minute as m ss", async () => {
    const messages: string[] = [];
    const realNow = Date.now;
    let now = realNow();
    Date.now = () => now;
    try {
      await runWithSyncProgress(
        { source: "railgun", onUpdate: (m) => messages.push(m) },
        async () => {
          const ticket = addSyncUnits("rpc", 2);
          now += 59_000;
          ticket.advance();
          now += 1_000;
          ticket.advance();
        }
      );
    } finally {
      Date.now = realNow;
    }
    assert.ok(
      messages.some((m) => m.endsWith("59s")),
      messages.join("\n")
    );
    assert.ok(
      messages.some((m) => m.includes("1m 00s")),
      messages.join("\n")
    );
  });
});


describe("sync activities", () => {
  it("tracks concurrent activities without persisting finished network stages", async () => {
    const messages = await capture({ source: "railgun" }, async () => {
      const finishHistory = beginSyncActivity("Subsquid history · total unavailable");
      const finishPoi = beginSyncActivity("Railgun POI · total unavailable");
      finishHistory();
      await settle();
      finishPoi();
    });
    assert.ok(messages.some((message) => message.includes("Railgun POI")));
    assert.doesNotMatch(messages.at(-1)!, /Railgun POI|Subsquid history/);
  });

  it("ignores tickets and activities after their session closes", async () => {
    let ticket: ReturnType<typeof addSyncUnits>;
    let finish: () => void;
    await capture({ source: "tornado" }, () => {
      ticket = addSyncUnits("saga", 3);
      finish = beginSyncActivity("history");
    });
    const messages = await capture({ source: "railgun" }, () => {
      ticket!.advance();
      finish!();
    });
    assert.ok(messages.every((m) => !m.includes("Saga") && !m.includes("history")));
  });
});
