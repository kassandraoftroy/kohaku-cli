import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  beginSyncRpcWindows,
  reportSyncRpcWindow,
  runWithSyncProgress,
} from "../src/utils/sync-progress.js";

describe("cumulative RPC log windows", () => {
  it("does not reset to 1/N when a second getLogs range starts", async () => {
    const messages: string[] = [];
    await runWithSyncProgress(
      {
        protocol: "privacy-pools",
        onUpdate: (m) => messages.push(m),
      },
      async () => {
        beginSyncRpcWindows(11);
        reportSyncRpcWindow();
        reportSyncRpcWindow();
        beginSyncRpcWindows(11);
        reportSyncRpcWindow();
        await new Promise((r) => setTimeout(r, 300));
      }
    );
    const lastRpc = [...messages].reverse().find((m) => m.includes("RPC logs"));
    assert.ok(lastRpc, messages.join("\n"));
    assert.match(lastRpc, /3\/22/);
  });
});
