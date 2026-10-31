import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { EthereumProvider } from "@kohaku-eth/provider";

import { withChunkedGetLogs } from "../src/host/chunked-get-logs.js";
import { runWithSyncProgress } from "../src/utils/sync-progress.js";
import { formatKnownWorkEta, formatProgressMetrics } from "../src/utils/sync-progress-renderer.js";

const address = "0x1111111111111111111111111111111111111111" as const;
const settle = () => new Promise((resolve) => setTimeout(resolve, 270));

function provider(head: bigint | (() => bigint), logs: () => Promise<unknown[]> = async () => []) {
  const getHead = () => typeof head === "function" ? head() : head;
  return withChunkedGetLogs({
    getBlockNumber: async () => getHead(),
    getLogs: logs,
    request: async ({ method }: { method: string }) => method === "eth_blockNumber"
      ? `0x${getHead().toString(16)}` : logs(),
  } as unknown as EthereumProvider, { syncToHead: true });
}

describe("SDK batches across a whole RPC scan", () => {
  for (const source of ["railgun", "tornado", "privacy-pools"] as const) {
    it(`${source} keeps a fixed block total across SDK batches`, async () => {
      const rpc = provider(1449n);
      const messages: string[] = [];
      await runWithSyncProgress({ source, onUpdate: (m) => messages.push(m) }, async () => {
        await rpc.getBlockNumber();
        for (const [from, to] of [[100n, 549n], [550n, 999n], [1000n, 1449n]]) {
          if (source === "railgun") {
            await rpc.request({ method: "eth_getLogs", params: [{ address,
              fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}` }] });
          } else {
            await rpc.getLogs({ address, fromBlock: from, toBlock: to });
          }
          await settle();
        }
      });
      for (const done of [450, 900, 1350]) {
        assert.ok(messages.some((m) => m.includes(`${done}/1350 blocks`)), messages.join("\n"));
      }
      assert.ok(messages.every((m) => !m.includes("1/1")));
    });
  }

  it("does not count overlap, duplicate windows, or failed requests", async () => {
    let fail = false;
    const rpc = provider(1099n, async () => {
      if (fail) throw new Error("RPC unavailable");
      return [];
    });
    const messages: string[] = [];
    await runWithSyncProgress({ source: "tornado", onUpdate: (m) => messages.push(m) }, async () => {
      await rpc.getBlockNumber();
      await rpc.getLogs({ address, fromBlock: 100n, toBlock: 599n });
      await rpc.getLogs({ address, fromBlock: 100n, toBlock: 599n });
      await rpc.getLogs({ address, fromBlock: 599n, toBlock: 799n });
      fail = true;
      await assert.rejects(rpc.getLogs({ address, fromBlock: 800n, toBlock: 1099n }));
    });
    assert.match(messages.at(-1)!, /700\/1000 blocks/);
    assert.doesNotMatch(messages.at(-1)!, /task complete/);
  });

  it("keeps parallel event streams independent and resets the head for a new session", async () => {
    let head = 999n;
    const rpc = provider(() => head);
    const messages: string[] = [];
    await runWithSyncProgress({ source: "railgun", onUpdate: (m) => messages.push(m) }, async () => {
      await rpc.request({ method: "eth_blockNumber" });
      await Promise.all(["0xaaa", "0xbbb"].map((topic) => rpc.request({
        method: "eth_getLogs", params: [{ address, topics: [topic], fromBlock: "0x0", toBlock: "0x1c1" }],
      })));
    });
    assert.match(messages.at(-1)!, /0xaaa 450\/1000 blocks/);
    assert.match(messages.at(-1)!, /0xbbb 450\/1000 blocks/);

    head = 1999n;
    const next: string[] = [];
    await runWithSyncProgress({ source: "railgun", onUpdate: (m) => next.push(m) }, async () => {
      // Discover a fresh head even when the SDK did not request one first.
      await rpc.getLogs({ address, fromBlock: 0n, toBlock: 9n });
    });
    assert.match(next.at(-1)!, /10\/2000 blocks/);
  });

  for (const source of ["privacy-pools", "tornado", "railgun"] as const) {
    it(`${source} finishes the existing bar when the final batch crosses the frozen head`, async () => {
      let head = 20944n;
      const rpc = provider(() => head);
      const messages: string[] = [];
      await runWithSyncProgress({ source, onUpdate: (m) => messages.push(m) }, async () => {
        // Provider construction can observe a head before SDK event syncing starts.
        await rpc.getBlockNumber();
        for (let start = 0n; start < 20000n; start += 5000n) {
          await rpc.getLogs({ address, fromBlock: start, toBlock: start + 5000n });
        }
        await settle();
        assert.match(messages.at(-1)!, /20001\/20945 blocks/);

        head = 20946n;
        await rpc.getBlockNumber();
        await rpc.getLogs({ address, fromBlock: 20000n, toBlock: head });
        await settle();
        assert.match(messages.at(-1)!, /20945\/20945 blocks · task complete/);
        assert.doesNotMatch(messages.at(-1)!, /pass 2|20001\//);

        // The next derivation pass is real new work, but its completed
        // predecessor must not be displayed beside it as a duplicate bar.
        await rpc.getLogs({ address, fromBlock: 0n, toBlock: 5000n });
        await settle();
        assert.match(messages.at(-1)!, /\(pass 2\) 5001\/20945 blocks/);
        assert.equal((messages.at(-1)!.match(/RPC 0x111111/g) ?? []).length, 1);
        assert.doesNotMatch(messages.at(-1)!, /task complete|20001\//);
      });
    });
  }

  it("keeps single-block metadata lookups bounded", async () => {
    const rpc = provider(999n);
    const messages: string[] = [];
    await runWithSyncProgress({ source: "privacy-pools", onUpdate: (m) => messages.push(m) }, async () => {
      await rpc.getBlockNumber();
      await rpc.getLogs({ address, fromBlock: 100n, toBlock: 100n });
    });
    assert.match(messages.at(-1)!, /1\/1 blocks · task complete/);
  });
});

describe("task throughput and ETA", () => {
  const row = { label: "RPC", done: 500, total: 1000, suffix: "", unit: "blocks",
    startedAt: 0, updatedAt: 5000, samples: 3 };
  it("waits for a meaningful sample", () => {
    assert.match(formatProgressMetrics({ ...row, samples: 1 }, 5000), /measuring speed/);
  });
  it("estimates the remaining task from its own elapsed time", () => {
    assert.equal(formatProgressMetrics(row, 5000), "50% · 100 blocks/s · task ETA ~5s");
  });
  it("marks a slow current step without hiding the task estimate", () => {
    assert.match(formatProgressMetrics(row, 40000), /task ETA ~5s \(current step slow\)/);
    assert.equal(formatProgressMetrics({ ...row, done: 1000 }, 21000), "task complete");
  });
  it("shows elapsed time before the first update and precise early percentages", () => {
    assert.equal(formatProgressMetrics({ ...row, done: 0, samples: 0 }, 97_000),
      "0% · first range in progress (1m 37s) · ETA after progress");
    assert.match(formatProgressMetrics({ ...row, done: 5, samples: 1 }, 5000), /^0.50% · measuring speed/);
  });
  it("excludes one-time setup from later speed and estimates visible tasks together", () => {
    const first = { ...row, done: 30, total: 100, startedAt: 0,
      rateStartAt: 100_000, rateStartDone: 10, updatedAt: 110_000, samples: 2 };
    assert.equal(formatProgressMetrics(first, 110_000), "30% · 2.0 blocks/s · task ETA ~35s");
    const second = { ...row, done: 50, total: 100, startedAt: 0,
      rateStartAt: 100_000, rateStartDone: 10, updatedAt: 110_000, samples: 2 };
    assert.equal(formatKnownWorkEta([first, second]), "Known steps ETA ~35s-48s (more may follow)");
  });
});
