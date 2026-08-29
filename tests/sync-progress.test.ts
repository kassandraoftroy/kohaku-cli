import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  countSyncRequest,
  noteSyncFirstRun,
  reportSyncBlockProgress,
  reportSyncPhase,
  runWithSyncProgress,
} from "../src/utils/sync-progress.js";

/** Progress emits are coalesced, so settle before inspecting messages. */
const settle = () => new Promise((r) => setTimeout(r, 300));

async function capture(
  opts: Parameters<typeof runWithSyncProgress>[0],
  body: () => void
): Promise<string[]> {
  const messages: string[] = [];
  await runWithSyncProgress({ ...opts, onUpdate: (m) => messages.push(m) }, async () => {
    body();
    await settle();
  });
  return messages;
}

describe("sync progress phases", () => {
  it("reports the most recent phase, without latching on an earlier one", async () => {
    const messages = await capture({ source: "railgun" }, () => {
      for (let i = 0; i < 3; i++) countSyncRequest("rpc");
      countSyncRequest("subsquid");
    });
    const last = messages.at(-1)!;
    assert.match(last, /Subsquid over Tor/, messages.join("\n"));
    assert.doesNotMatch(last, /RPC logs/);
  });

  it("omits request counts for privacy protocols", async () => {
    const messages = await capture({ source: "privacy-pools" }, () => {
      for (let i = 0; i < 7; i++) countSyncRequest("rpc");
      for (let i = 0; i < 2; i++) countSyncRequest("asp");
    });
    const last = messages.at(-1)!;
    assert.match(last, /ASP/, messages.join("\n"));
    assert.doesNotMatch(last, /req/, messages.join("\n"));
    assert.doesNotMatch(last, /RPC logs/, messages.join("\n"));

    const backToRpc = await capture({ source: "privacy-pools" }, () => {
      countSyncRequest("rpc");
      countSyncRequest("saga");
      countSyncRequest("rpc");
    });
    assert.match(backToRpc.at(-1)!, /RPC logs/, backToRpc.join("\n"));
    assert.doesNotMatch(backToRpc.at(-1)!, /req/, backToRpc.join("\n"));
    assert.doesNotMatch(backToRpc.at(-1)!, /saga CDN/, backToRpc.join("\n"));
  });

  it("still switches phase without showing a count", async () => {
    const messages = await capture({ source: "privacy-pools" }, () => {
      for (let i = 0; i < 11; i++) countSyncRequest("rpc");
      for (let i = 0; i < 11; i++) countSyncRequest("rpc");
    });
    const last = messages.at(-1)!;
    assert.match(last, /RPC logs/, messages.join("\n"));
    assert.doesNotMatch(last, /req/, messages.join("\n"));
  });

  it("switches phase without a count via reportSyncPhase", async () => {
    const messages = await capture({ source: "tornado" }, () => {
      reportSyncPhase("saga");
    });
    const last = messages.at(-1)!;
    assert.match(last, /saga CDN/, messages.join("\n"));
    assert.doesNotMatch(last, /req/);
  });

  it("reports 'starting' before any phase is known", async () => {
    const messages = await capture({ source: "railgun" }, () => {});
    assert.match(messages[0]!, /^Railgun sync · starting · \d+s$/, messages.join("\n"));
  });
});

describe("sync progress labels", () => {
  it("marks a first run and leaves incremental runs unmarked", async () => {
    const first = await capture({ source: "railgun", firstRun: true }, () => {
      countSyncRequest("subsquid");
    });
    assert.match(first.at(-1)!, /^Railgun first sync · /, first.join("\n"));

    const incremental = await capture({ source: "railgun" }, () => {
      countSyncRequest("subsquid");
    });
    assert.match(incremental.at(-1)!, /^Railgun sync · /, incremental.join("\n"));
  });

  it("calls the stealth source a scan and omits request counts", async () => {
    const first = await capture({ source: "stealth", firstRun: true }, () => {
      countSyncRequest("rpc");
    });
    assert.match(first.at(-1)!, /^Stealth first scan · /, first.join("\n"));
    assert.doesNotMatch(first.at(-1)!, /req/, first.join("\n"));

    const incremental = await capture({ source: "stealth" }, () => {
      countSyncRequest("rpc");
    });
    assert.match(incremental.at(-1)!, /^Stealth scan · /, incremental.join("\n"));
    assert.doesNotMatch(incremental.at(-1)!, /req/, incremental.join("\n"));
  });

  it("shows stealth block progress as scanned/total", async () => {
    const messages = await capture({ source: "stealth" }, () => {
      countSyncRequest("rpc");
      reportSyncBlockProgress(500n, 1000n);
    });
    assert.match(
      messages.at(-1)!,
      /RPC logs · 500\/1000 blocks/,
      messages.join("\n")
    );
    assert.doesNotMatch(messages.at(-1)!, /req/, messages.join("\n"));
  });

  it("lets an inner scope refine the first-run label", async () => {
    const messages = await capture({ source: "stealth" }, () => {
      noteSyncFirstRun(true);
      countSyncRequest("rpc");
    });
    assert.match(messages.at(-1)!, /^Stealth first scan · /, messages.join("\n"));
  });

  it("names each protocol", async () => {
    for (const [source, label] of [
      ["railgun", "Railgun"],
      ["privacy-pools", "Privacy Pools"],
      ["tornado", "Tornado Cash"],
    ] as const) {
      const messages = await capture({ source }, () => countSyncRequest("rpc"));
      assert.match(messages.at(-1)!, new RegExp(`^${label} sync · `));
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
      countSyncRequest("rpc");
      await settle();
    });
    // Nested scopes reuse the outer store, so a nested onUpdate is ignored too.
    await runWithSyncProgress({ source: "railgun" }, async () => {
      await runWithSyncProgress(
        { source: "tornado", onUpdate: () => (emitted += 1) },
        async () => {
          countSyncRequest("rpc");
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
          now += 59_000;
          countSyncRequest("rpc");
          now += 1_000;
          countSyncRequest("rpc");
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
