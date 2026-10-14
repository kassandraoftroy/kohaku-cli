import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { join } from "node:path";
import { describe, it } from "node:test";

import { connectCommandRpc } from "../src/utils/rpc.js";
import {
  DEFAULT_PIR_URL,
  buildPirFacadeArgs,
  isLoopbackRpcUrl,
  launchPirFacade,
  pirBinaryCandidates,
  resolvePirBaseUrl,
  resolvePirBinary,
  waitForPirFacade,
} from "../src/utils/pir-facade.js";

function fakeChild() {
  const exitListeners: Array<
    (code: number | null, signal: NodeJS.Signals | null) => void
  > = [];
  const errorListeners: Array<(err: Error) => void> = [];
  const child = {
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    killed: false,
    unref() {},
    kill() {
      child.killed = true;
      return true;
    },
    once(
      event: string,
      fn:
        | ((code: number | null, signal: NodeJS.Signals | null) => void)
        | ((err: Error) => void)
    ) {
      if (event === "exit") {
        exitListeners.push(
          fn as (code: number | null, signal: NodeJS.Signals | null) => void
        );
      }
      if (event === "error") errorListeners.push(fn as (err: Error) => void);
      return child;
    },
    emitExit(code: number) {
      child.exitCode = code;
      for (const fn of exitListeners) fn(code, null);
    },
  };
  return child;
}

describe("isLoopbackRpcUrl", () => {
  it("treats localhost and loopback as direct RPC", () => {
    assert.equal(isLoopbackRpcUrl("http://localhost:8545"), true);
    assert.equal(isLoopbackRpcUrl("http://127.0.0.1:8545"), true);
    assert.equal(isLoopbackRpcUrl("http://[::1]:8545"), true);
  });

  it("treats a public URL as a PIR fallback", () => {
    assert.equal(isLoopbackRpcUrl("https://ethereum.publicnode.com"), false);
  });
});

describe("resolvePirBaseUrl", () => {
  it("uses the built-in host unless PIR_URL is set", () => {
    assert.equal(resolvePirBaseUrl({}), DEFAULT_PIR_URL);
    assert.equal(
      resolvePirBaseUrl({ PIR_URL: " http://pir.example:18090 " }),
      "http://pir.example:18090"
    );
  });
});

describe("resolvePirBinary", () => {
  it("prefers KOHAKU_PIR_RPC_BIN when that file exists", () => {
    assert.equal(
      resolvePirBinary({
        env: { KOHAKU_PIR_RPC_BIN: "/opt/local-pir-rpc" },
        exists: (path) => path === "/opt/local-pir-rpc",
      }),
      "/opt/local-pir-rpc"
    );
  });

  it("uses the packaged binary, then the in-tree release build", () => {
    const root = "/pkg/kohaku-cli";
    const [packaged, inTree] = pirBinaryCandidates(root);
    assert.equal(packaged, join(root, "bin", "local-pir-rpc"));
    assert.equal(
      inTree,
      join(root, "local-pir-rpc", "target", "release", "local-pir-rpc")
    );
    assert.equal(
      resolvePirBinary({
        packageRoot: root,
        env: {},
        exists: (path) => path === packaged,
      }),
      packaged
    );
    assert.equal(
      resolvePirBinary({
        packageRoot: root,
        env: {},
        exists: (path) => path === inTree,
      }),
      inTree
    );
  });

  it("names every path it tried when the binary is missing", () => {
    assert.throws(
      () =>
        resolvePirBinary({
          packageRoot: "/pkg/kohaku-cli",
          env: {},
          exists: () => false,
        }),
      /KOHAKU_PIR_RPC_BIN/
    );
  });
});

describe("buildPirFacadeArgs", () => {
  it("passes the user URL as fallback and adds --without-tor only when asked", () => {
    assert.deepEqual(
      buildPirFacadeArgs({
        listen: "127.0.0.1:9",
        pirUrl: DEFAULT_PIR_URL,
        fallbackRpcUrl: "https://ethereum.publicnode.com",
        withoutTor: false,
      }),
      [
        "--listen",
        "127.0.0.1:9",
        "--pir-url",
        DEFAULT_PIR_URL,
        "--rpc-url",
        "https://ethereum.publicnode.com",
      ]
    );
    const clearnet = buildPirFacadeArgs({
      listen: "127.0.0.1:9",
      pirUrl: "http://pir.example:18090",
      fallbackRpcUrl: "https://ethereum.publicnode.com",
      withoutTor: true,
    });
    assert.equal(clearnet.at(-1), "--without-tor");
  });
});

describe("launchPirFacade", () => {
  it("spawns the facade and returns its localhost URL once eth_chainId answers", async () => {
    const child = fakeChild();
    let args: string[] = [];
    const launched = await launchPirFacade({
      fallbackRpcUrl: "https://ethereum.publicnode.com",
      pirUrl: DEFAULT_PIR_URL,
      withoutTor: false,
      binary: "/opt/local-pir-rpc",
      port: 32123,
      timeoutMs: 1_000,
      spawnProcess: (_binary, spawnArgs) => {
        args = spawnArgs;
        return child as unknown as ChildProcess;
      },
      probe: async () => true,
    });
    assert.equal(launched.url, "http://127.0.0.1:32123");
    assert.deepEqual(args.slice(0, 6), [
      "--listen",
      "127.0.0.1:32123",
      "--pir-url",
      DEFAULT_PIR_URL,
      "--rpc-url",
      "https://ethereum.publicnode.com",
    ]);
  });

  it("fails when the process exits before it is ready", async () => {
    const child = fakeChild();
    await assert.rejects(
      () =>
        waitForPirFacade({
          url: "http://127.0.0.1:1",
          child: child as unknown as ChildProcess,
          timeoutMs: 1_000,
          probe: async () => {
            child.emitExit(1);
            return false;
          },
        }),
      /exited before it was ready/
    );
  });
});

describe("connectCommandRpc", () => {
  it("leaves a localhost URL alone", async () => {
    const url = await connectCommandRpc("http://127.0.0.1:8545");
    assert.equal(url, "http://127.0.0.1:8545");
  });
});
