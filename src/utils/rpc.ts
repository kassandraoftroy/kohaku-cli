import { homedir } from "node:os";
import { join } from "node:path";
import {
  createPublicClient,
  defineChain,
  http,
  type Chain,
  type PublicClient,
  type Transport,
} from "viem";
import { mainnet, sepolia } from "viem/chains";

import { appendNetworkTraffic, redactUrl } from "./network-traffic-log.js";
import { ensurePirFacade, isLoopbackRpcUrl } from "./pir-facade.js";
import { resolvePimlicoBundlerUrl } from "./tor.js";
import { expectedChainIdStringFromWalletDir } from "./wallets-util";

export type KohakuPublicClient = PublicClient<Transport, Chain>;

/** Default Kohaku data root: `~/.kohaku-cli`. */
export const DEFAULT_DATA_DIR = join(homedir(), ".kohaku-cli");

/** Used when neither `--rpc-url` nor `RPC_URL` is set (local node). */
export const DEFAULT_RPC_URL = "http://localhost:8545";

/**
 * viem's default is 10s. One balances POST can hold up to 100 calls, and
 * clearnet local-pir-rpc answers that batch one PIR lookup at a time
 * (~1s each). The server only logs the batch once it has finished, so a
 * client abort looks like a silent timeout.
 */
const RPC_HTTP_TIMEOUT_MS = 180_000;

function chainForId(chainId: bigint, rpcUrl: string): Chain {
  if (chainId === 1n) return mainnet;
  if (chainId === 11155111n) return sepolia;
  const id = Number(chainId);
  return defineChain({
    id,
    name: `chain-${id}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
}

async function detectChainId(rpcUrl: string): Promise<bigint> {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
  });
  if (!res.ok) {
    throw new Error(
      `RPC network detection failed for ${rpcUrl}. HTTP ${res.status} ${res.statusText}`
    );
  }
  const json = (await res.json()) as { result?: string; error?: { message?: string } };
  if (json.error?.message) {
    throw new Error(
      `RPC network detection failed for ${rpcUrl}. ${json.error.message}`
    );
  }
  if (!json.result) {
    throw new Error(`RPC network detection failed for ${rpcUrl}. Missing eth_chainId result.`);
  }
  return BigInt(json.result);
}

function rpcMethodFromBody(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as
      | { method?: string }
      | Array<{ method?: string }>;
    if (Array.isArray(parsed)) {
      if (parsed.length === 0) return "batch(0)";
      const methods = parsed.map((item) => item.method ?? "?");
      const unique = [...new Set(methods)];
      const summary =
        unique.length <= 4
          ? unique.join(",")
          : `${unique.slice(0, 3).join(",")},+${unique.length - 3}`;
      return `batch(${parsed.length}:${summary})`;
    }
    return parsed.method;
  } catch {
    return undefined;
  }
}

function wrapFetchWithTrafficLog(rpcUrl: string): typeof fetch {
  const redacted = redactUrl(rpcUrl);
  return async (input, init) => {
    const started = Date.now();
    let rpcMethod: string | undefined;
    const body = init?.body;
    if (typeof body === "string") {
      rpcMethod = rpcMethodFromBody(body);
    }

    try {
      const response = await fetch(input, init);
      appendNetworkTraffic({
        kind: "rpc",
        method: "POST",
        url: redacted,
        via: "clearnet",
        clearnetReason: "rpc",
        category: "rpc",
        ok: response.ok,
        status: response.status,
        durationMs: Date.now() - started,
        rpcMethod,
      });
      return response;
    } catch (err) {
      appendNetworkTraffic({
        kind: "rpc",
        method: "POST",
        url: redacted,
        via: "clearnet",
        clearnetReason: "rpc",
        category: "rpc",
        ok: false,
        durationMs: Date.now() - started,
        rpcMethod,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  };
}

/** Create a viem public client for the given RPC URL (chain detected on first use). */
export async function makePublicClient(rpcUrl: string): Promise<KohakuPublicClient> {
  let chainId: bigint;
  try {
    chainId = await detectChainId(rpcUrl);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(
      `RPC network detection failed for ${rpcUrl}. Check the URL and that the node is reachable.\n${detail}`,
      { cause: cause instanceof Error ? cause : undefined }
    );
  }

  const chain = chainForId(chainId, rpcUrl);
  return createPublicClient({
    chain,
    transport: http(rpcUrl, {
      fetchFn: wrapFetchWithTrafficLog(rpcUrl),
      timeout: RPC_HTTP_TIMEOUT_MS,
      // Coalesce concurrent JSON-RPC calls into one HTTP POST (any compliant node).
      batch: { batchSize: 100, wait: 10 },
    }),
  });
}

/** Viem clients are stateless; kept for call-site symmetry with the old ethers provider. */
export function disposePublicClient(_client?: KohakuPublicClient): void {}

/**
 * `--rpc-url` or `RPC_URL` when the user actually set one.
 * Does not fall back to localhost — use {@link resolveRpcUrl} for that.
 */
export function resolveOptionalRpcUrl(optsRpcUrl?: string): string | undefined {
  const fromOpt = optsRpcUrl?.trim();
  if (fromOpt) return fromOpt;
  const fromEnv = process.env.RPC_URL?.trim();
  if (fromEnv) return fromEnv;
  return undefined;
}

/**
 * RPC endpoint from `--rpc-url`, else `RPC_URL`, else {@link DEFAULT_RPC_URL}.
 * Warns on stderr when the localhost default is used as a fallback.
 */
export function resolveRpcUrl(optsRpcUrl?: string): string {
  const configured = resolveOptionalRpcUrl(optsRpcUrl);
  if (configured) return configured;
  console.warn(
    `No --rpc-url / RPC_URL set; using default ${DEFAULT_RPC_URL}`
  );
  return DEFAULT_RPC_URL;
}

/** PIR lookups exist only for Ethereum mainnet. */
export const PIR_CHAIN_ID = 1n;

/**
 * `--use-pir` is refused for every wallet that is not mainnet.
 * `chainId` is the wallet's chain (`1` or `11155111`), not the RPC's.
 */
export function assertPirMainnet(chainId: bigint | string): void {
  const id = typeof chainId === "bigint" ? chainId : BigInt(chainId);
  if (id === PIR_CHAIN_ID) return;
  throw new Error(
    `PIR only works on mainnet (chain id ${PIR_CHAIN_ID.toString()}). This wallet is chain id ${id.toString()}.`
  );
}

/**
 * URL viem and name resolvers should call.
 *
 * Without `--use-pir`, the resolved URL is used directly.
 * With `--use-pir`, a non-mainnet wallet throws. A mainnet loopback URL is
 * still used directly. Any other mainnet URL starts the bundled facade:
 * that URL is only the fallback, and PIR-eligible calls go to the built-in
 * PIR host (`PIR_URL` overrides it).
 */
export async function connectCommandRpc(
  optsRpcUrl?: string,
  opts?: { withoutTor?: boolean; usePir?: boolean; chainId?: bigint | string }
): Promise<string> {
  const userUrl = resolveRpcUrl(optsRpcUrl);
  if (!opts?.usePir) return userUrl;
  if (opts.chainId === undefined) {
    throw new Error("--use-pir requires the wallet chain id.");
  }
  assertPirMainnet(opts.chainId);
  if (isLoopbackRpcUrl(userUrl)) return userUrl;
  return ensurePirFacade({
    fallbackRpcUrl: userUrl,
    withoutTor: opts.withoutTor,
  });
}

/** Pimlico public ERC-4337 bundler (no API key). Uses Tor localhost proxy when a Tor session is active. */
export function railgunPimlicoBundlerUrl(chainId: bigint): string {
  return resolvePimlicoBundlerUrl(chainId);
}

/**
 * Fetches the RPC network chain id and ensures it matches the wallet's expected chain
 * (from `.wallet-type`: mainnet `1` vs testnet `11155111`).
 */
export async function getRpcChainIdMatchingWallet(
  rpcUrl: string,
  walletDir: string
): Promise<bigint> {
  const expectedStr = expectedChainIdStringFromWalletDir(walletDir);
  const client = await makePublicClient(rpcUrl);
  const chainId = BigInt(await client.getChainId());
  if (chainId.toString() !== expectedStr) {
    throw new Error(
      `RPC chainId ${chainId.toString()} does not match wallet chainId ${expectedStr}.`
    );
  }
  return chainId;
}

/** Public HTTP RPCs used when `--rpc-url` / `RPC_URL` is unset (create-wallet seed timestamp). */
const PUBLIC_RPC_URLS: Record<"mainnet" | "sepolia", readonly string[]> = {
  mainnet: [
    "https://eth.drpc.org",
    "https://1rpc.io/eth",
    "https://ethereum.public.blockpi.network/v1/rpc/public",
    "https://gateway.tenderly.co/public/mainnet",
  ],
  sepolia: [
    "https://1rpc.io/sepolia",
    "https://gateway.tenderly.co/public/sepolia",
    "https://sepolia.gateway.tenderly.co",
  ],
};

function publicRpcCandidates(testnet: boolean): readonly string[] {
  return testnet ? PUBLIC_RPC_URLS.sepolia : PUBLIC_RPC_URLS.mainnet;
}

/**
 * RPCs to try for a one-shot `eth_blockNumber` (create-wallet stealth start block).
 * Localhost is included only when the caller passed it as `rpcUrl`.
 */
export function currentBlockRpcCandidates(opts: {
  testnet: boolean;
  rpcUrl?: string;
}): string[] {
  const preferred = opts.rpcUrl?.trim();
  const publicUrls = publicRpcCandidates(opts.testnet);
  if (!preferred) return [...publicUrls];
  return [preferred, ...publicUrls.filter((u) => u !== preferred)];
}

/**
 * Current block height for mainnet or Sepolia.
 * Prefers `rpcUrl` when provided (must match the network); otherwise tries public RPCs.
 */
export async function fetchCurrentBlockNumber(opts: {
  testnet: boolean;
  /** Preferred RPC (e.g. `--rpc-url` / `RPC_URL`). */
  rpcUrl?: string;
}): Promise<{ blockNumber: bigint; rpcUrlUsed: string }> {
  const expectedChainId = opts.testnet ? 11155111n : 1n;
  const candidates = currentBlockRpcCandidates(opts);

  const errors: string[] = [];
  for (const url of candidates) {
    try {
      const client = await makePublicClient(url);
      try {
        const chainId = BigInt(await client.getChainId());
        if (chainId !== expectedChainId) {
          throw new Error(
            `chain ID ${chainId.toString()} (expected ${expectedChainId.toString()})`
          );
        }
        const blockNumber = await client.getBlockNumber();
        return { blockNumber, rpcUrlUsed: url };
      } finally {
        disposePublicClient(client);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`${url}: ${msg}`);
    }
  }

  throw new Error(
    `Could not fetch current block for ${opts.testnet ? "Sepolia" : "mainnet"}.\n` +
      errors.map((line) => `  - ${line}`).join("\n")
  );
}
