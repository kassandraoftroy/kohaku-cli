import { JsonRpcProvider, type Network } from "ethers";

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
    const detail =
      cause instanceof Error ? cause.message : String(cause);
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
