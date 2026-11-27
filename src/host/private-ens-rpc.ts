import type { Host } from "@kohaku-eth/plugins";
import { http } from "viem";

type Provider = Host["provider"];
type Request = Parameters<Provider["request"]>[0];
const rpcUrls = new WeakMap<Provider, string>();

/** Retain the explicit endpoint without depending on viem's private fields. */
export function registerPrivateEnsRpc(provider: Provider, rpcUrl: string): void {
  rpcUrls.set(provider, rpcUrl);
}

/** An ENS lookup never falls back to the provider's ordinary read transport. */
export async function privateEnsRpcRequest(
  provider: Provider, request: Request, fetchFn: typeof fetch,
): Promise<unknown> {
  const rpcUrl = rpcUrls.get(provider);
  if (!rpcUrl) throw new Error("Private ENS lookup is missing its configured RPC endpoint.");
  const transport = http(rpcUrl, { fetchFn, retryCount: 0, batch: false })({ retryCount: 0 });
  return transport.request(request as never);
}
