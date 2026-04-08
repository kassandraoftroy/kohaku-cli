import { homedir } from "node:os";
import { join } from "node:path";
import { JsonRpcProvider, type Network } from "ethers";

import { expectedChainIdStringFromWalletDir } from "./wallets-util";

/**
 * Detects chain/network via a throwaway provider, then always destroys it.
 * If `getNetwork()` throws (RPC down, wrong URL, TLS, etc.), the error propagates
 * after cleanup — we never build the static-network provider with a missing `Network`.
 */
async function detectNetworkOrThrow(rpcUrl: string): Promise<Network> {
  const bootstrap = new JsonRpcProvider(rpcUrl);
  try {
    return await bootstrap.getNetwork();
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(
      `RPC network detection failed for ${rpcUrl}. Check the URL and that the node is reachable.\n${detail}`,
      { cause: cause instanceof Error ? cause : undefined }
    );
  } finally {
    bootstrap.destroy();
  }
}

export async function makeEthersProvider(rpcUrl: string): Promise<JsonRpcProvider> {
  const network = await detectNetworkOrThrow(rpcUrl);
  return new JsonRpcProvider(rpcUrl, network, {
    staticNetwork: network,
  });
}

/** Default Kohaku data root: `~/.kohaku-cli`. */
export const DEFAULT_DATA_DIR = join(homedir(), ".kohaku-cli");

/**
 * RPC endpoint from `--rpc-url` or the `RPC_URL` environment variable (trimmed).
 * Returns empty string if neither is set.
 */
export function resolveRpcUrl(optsRpcUrl?: string): string {
  return optsRpcUrl?.trim() || process.env.RPC_URL?.trim() || "";
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
  const rpc = await makeEthersProvider(rpcUrl);
  try {
    const chainId = (await rpc.getNetwork()).chainId;
    if (chainId.toString() !== expectedStr) {
      throw new Error(
        `RPC chainId ${chainId.toString()} does not match wallet chainId ${expectedStr}.`
      );
    }
    return chainId;
  } finally {
    rpc.destroy();
  }
}
