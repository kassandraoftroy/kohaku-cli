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
 * RPC endpoint from `--rpc-url` or the `RPC_URL` environment variable (trimmed).
 * Returns empty string if neither is set.
 */
export function resolveRpcUrl(optsRpcUrl?: string): string {
  return optsRpcUrl?.trim() || process.env.RPC_URL?.trim() || "";
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
