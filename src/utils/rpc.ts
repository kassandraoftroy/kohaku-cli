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
import { resolvePimlicoBundlerUrl } from "./tor.js";
import { expectedChainIdStringFromWalletDir } from "./wallets-util";

export type KohakuPublicClient = PublicClient<Transport, Chain>;

/** Default Kohaku data root: `~/.kohaku-cli`. */
export const DEFAULT_DATA_DIR = join(homedir(), ".kohaku-cli");

/** Used when neither `--rpc-url` nor `RPC_URL` is set (local node). */
export const DEFAULT_RPC_URL = "http://localhost:8545";

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

function wrapFetchWithTrafficLog(rpcUrl: string): typeof fetch {
  const redacted = redactUrl(rpcUrl);
  return async (input, init) => {
    const started = Date.now();
    let rpcMethod: string | undefined;
    try {
      const body = init?.body;
      if (typeof body === "string") {
        const parsed = JSON.parse(body) as { method?: string };
        rpcMethod = parsed.method;
      }
    } catch {
      // ignore parse errors for traffic metadata
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
    transport: http(rpcUrl, { fetchFn: wrapFetchWithTrafficLog(rpcUrl) }),
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
