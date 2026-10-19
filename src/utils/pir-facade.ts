// Spawned child, not an in-process addon. napi-rs is only worth it if the
// process boundary gets in the way. WASM waits until a browser host needs it.

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Account PIR base. Tokens are this URL at port+1, names at port+2
 * (`local-pir-rpc` derives those). Override with `PIR_URL`.
 */
export const DEFAULT_PIR_URL = "http://188.166.42.59:18090";

/** How long to wait for Tor bootstrap and the facade to accept `eth_chainId`. */
const READY_TIMEOUT_MS = 180_000;

const children = new Set<ChildProcess>();
let exitHookInstalled = false;

export function isLoopbackRpcUrl(rpcUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(rpcUrl);
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
}

export function resolvePirBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.PIR_URL?.trim();
  return fromEnv || DEFAULT_PIR_URL;
}

export function envWithoutTor(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.KOHAKU_WITHOUT_TOR?.trim().toLowerCase();
  return raw === "1" || raw === "true";
}

export function packageRootFromModuleUrl(moduleUrl: string): string {
  const dir = dirname(fileURLToPath(moduleUrl));
  if (basename(dir) === "utils") return resolve(dir, "../..");
  return resolve(dir, "..");
}

function binaryName(): string {
  return process.platform === "win32" ? "local-pir-rpc.exe" : "local-pir-rpc";
}

/** Paths checked when `KOHAKU_PIR_RPC_BIN` is unset. */
export function pirBinaryCandidates(packageRoot: string): string[] {
  const name = binaryName();
  return [
    join(packageRoot, "bin", name),
    join(packageRoot, "local-pir-rpc", "target", "release", name),
  ];
}

export function resolvePirBinary(opts?: {
  packageRoot?: string;
  env?: NodeJS.ProcessEnv;
  exists?: (path: string) => boolean;
}): string {
  const env = opts?.env ?? process.env;
  const exists = opts?.exists ?? existsSync;
  const override = env.KOHAKU_PIR_RPC_BIN?.trim();
  if (override) {
    if (!exists(override)) {
      throw new Error(
        `KOHAKU_PIR_RPC_BIN does not exist: ${override}`
      );
    }
    return override;
  }
  const root = opts?.packageRoot ?? packageRootFromModuleUrl(import.meta.url);
  const candidates = pirBinaryCandidates(root);
  const found = candidates.find((path) => exists(path));
  if (found) return found;
  throw new Error(
    `local-pir-rpc binary not found. Set KOHAKU_PIR_RPC_BIN or place it at ${candidates[0]}. Looked in:\n` +
      candidates.map((path) => `  - ${path}`).join("\n")
  );
}

export function buildPirFacadeArgs(opts: {
  listen: string;
  pirUrl: string;
  fallbackRpcUrl: string;
  withoutTor: boolean;
}): string[] {
  const args = [
    "--listen",
    opts.listen,
    "--pir-url",
    opts.pirUrl,
    "--rpc-url",
    opts.fallbackRpcUrl,
  ];
  if (opts.withoutTor) args.push("--without-tor");
  return args;
}

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on("exit", () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
      }
    }
  });
}

function track(child: ChildProcess): void {
  children.add(child);
  child.unref();
  child.once("exit", () => {
    children.delete(child);
  });
  installExitHook();
}

export function reserveLoopbackPort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((err) => {
        if (err) reject(err);
        else if (!port) reject(new Error("failed to reserve a loopback port"));
        else resolvePort(port);
      });
    });
  });
}

async function probeChainId(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_chainId",
        params: [],
      }),
      signal: AbortSignal.timeout(2_000),
    });
    if (!res.ok) return false;
    const json = (await res.json()) as { result?: string };
    return typeof json.result === "string" && json.result.length > 0;
  } catch {
    return false;
  }
}

export async function waitForPirFacade(opts: {
  url: string;
  child: ChildProcess;
  timeoutMs?: number;
  probe?: (url: string) => Promise<boolean>;
}): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? READY_TIMEOUT_MS;
  const probe = opts.probe ?? probeChainId;
  const deadline = Date.now() + timeoutMs;
  let exitCode: number | null = null;
  let exitSignal: NodeJS.Signals | null = null;
  const failed: { error: Error | null } = { error: null };
  opts.child.once("exit", (code, signal) => {
    exitCode = code;
    exitSignal = signal;
  });
  opts.child.once("error", (err: Error) => {
    failed.error = err;
  });
  while (Date.now() < deadline) {
    if (failed.error) {
      throw new Error(`local-pir-rpc failed to start: ${failed.error.message}`);
    }
    if (exitCode !== null || exitSignal !== null) {
      throw new Error(
        `local-pir-rpc exited before it was ready (code ${exitCode ?? "null"}, signal ${exitSignal ?? "null"})`
      );
    }
    if (await probe(opts.url)) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  opts.child.kill("SIGTERM");
  throw new Error(`local-pir-rpc did not become ready within ${timeoutMs}ms (${opts.url})`);
}

export async function launchPirFacade(opts: {
  fallbackRpcUrl: string;
  pirUrl: string;
  withoutTor: boolean;
  binary: string;
  port: number;
  spawnProcess?: (binary: string, args: string[]) => ChildProcess;
  probe?: (url: string) => Promise<boolean>;
  timeoutMs?: number;
}): Promise<{ url: string; child: ChildProcess }> {
  const listen = `127.0.0.1:${opts.port}`;
  const url = `http://${listen}`;
  const args = buildPirFacadeArgs({
    listen,
    pirUrl: opts.pirUrl,
    fallbackRpcUrl: opts.fallbackRpcUrl,
    withoutTor: opts.withoutTor,
  });
  const spawnProcess =
    opts.spawnProcess ??
    ((binary, spawnArgs) =>
      spawn(binary, spawnArgs, {
        stdio: ["ignore", "inherit", "inherit"],
        env: process.env,
      }));
  const child = spawnProcess(opts.binary, args);
  track(child);
  try {
    await waitForPirFacade({
      url,
      child,
      timeoutMs: opts.timeoutMs,
      probe: opts.probe,
    });
  } catch (err) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
    }
    throw err;
  }
  return { url, child };
}

const inflight = new Map<string, Promise<string>>();

/**
 * Start (or reuse) a `local-pir-rpc` whose fallback is `fallbackRpcUrl`.
 * The returned URL is the localhost facade viem should use.
 */
export async function ensurePirFacade(opts: {
  fallbackRpcUrl: string;
  withoutTor?: boolean;
}): Promise<string> {
  const pirUrl = resolvePirBaseUrl();
  const withoutTor = opts.withoutTor ?? envWithoutTor();
  const key = `${pirUrl}\0${opts.fallbackRpcUrl}\0${withoutTor ? "1" : "0"}`;
  const existing = inflight.get(key);
  if (existing) return existing;
  const pending = (async () => {
    const binary = resolvePirBinary();
    const port = await reserveLoopbackPort();
    const launched = await launchPirFacade({
      fallbackRpcUrl: opts.fallbackRpcUrl,
      pirUrl,
      withoutTor,
      binary,
      port,
    });
    return launched.url;
  })();
  inflight.set(key, pending);
  try {
    return await pending;
  } catch (err) {
    inflight.delete(key);
    throw err;
  }
}
