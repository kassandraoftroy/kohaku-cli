import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  networkTrafficLogPath,
  runWithTrafficLogWallet,
} from "../src/utils/network-traffic-log.js";
import {
  kohakuFetch,
} from "../src/utils/tor.js";

const BODY = '{"status":"Missing","note":"MissingSomething"}';

function listen(handler: (body: string) => string): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const payload = handler(Buffer.concat(chunks).toString("utf8"));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(payload);
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr == null || typeof addr === "string") {
        reject(new Error("expected a TCP port"));
        return;
      }
      resolve({ server, url: `http://127.0.0.1:${addr.port}/poi` });
    });
  });
}

describe("Railgun PPOI HTTP routing", { concurrency: 1 }, () => {
  it("leaves PPOI Missing statuses intact even if the legacy override is set", async () => {
    const { server, url } = await listen(() => BODY);
    try {
      process.env.KOHAKU_RAILGUN_FORCE_VALID_POI = "true";
      const response = await kohakuFetch(url);
      assert.equal(await response.text(), BODY);
      assert.equal(response.url, url);
    } finally {
      delete process.env.KOHAKU_RAILGUN_FORCE_VALID_POI;
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  it("records the JSON-RPC method and a truncated post-body when Tor debug is on", async () => {
    const marker = "TAIL-MARKER-NOT-IN-PREFIX";
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "ppoi_pois_per_list",
      params: [marker.padStart(5000, "x")],
    });
    const { server, url } = await listen(() => '{"result":"Missing"}');
    const walletDir = mkdtempSync(join(tmpdir(), "kohaku-poi-log-"));
    const previousDebug = process.env.KOHAKU_TOR_DEBUG;
    const lines: unknown[][] = [];
    const orig = console.error;
    console.error = (...args: unknown[]) => {
      lines.push(args);
    };
    process.env.KOHAKU_TOR_DEBUG = "1";
    try {
      const res = await runWithTrafficLogWallet(walletDir, () =>
        kohakuFetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: payload,
        })
      );
      assert.equal(await res.text(), '{"result":"Missing"}');
      const dumped = lines.find((args) => args[0] === "[kohaku-tor]" && args[1] === "post-body");
      assert.ok(dumped, "expected a post-body debug line");
      const shown = String(dumped[2]);
      assert.match(shown, /ppoi_pois_per_list/);
      assert.equal(shown.includes(marker), false);
      assert.equal(shown.endsWith("…"), true);

      const log = readFileSync(networkTrafficLogPath(walletDir), "utf8");
      const entry = JSON.parse(log.trim().split("\n").at(-1)!) as { rpcMethod?: string };
      assert.equal(entry.rpcMethod, "ppoi_pois_per_list");
    } finally {
      console.error = orig;
      if (previousDebug === undefined) delete process.env.KOHAKU_TOR_DEBUG;
      else process.env.KOHAKU_TOR_DEBUG = previousDebug;
      rmSync(walletDir, { recursive: true, force: true });
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  it("peeks a Request body without requiring init.body", async () => {
    const { server, url } = await listen(() => "{}");
    const walletDir = mkdtempSync(join(tmpdir(), "kohaku-poi-req-"));
    try {
      await runWithTrafficLogWallet(walletDir, () =>
        kohakuFetch(
          new Request(url, {
            method: "POST",
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ppoi_submit_transact_proof" }),
          })
        )
      );
      const log = readFileSync(networkTrafficLogPath(walletDir), "utf8");
      const entry = JSON.parse(log.trim().split("\n").at(-1)!) as { rpcMethod?: string };
      assert.equal(entry.rpcMethod, "ppoi_submit_transact_proof");
    } finally {
      rmSync(walletDir, { recursive: true, force: true });
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });
});
