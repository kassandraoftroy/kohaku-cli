import type { KohakuPublicClient } from "./rpc.js";

/**
 * HD-derived public addresses are expected to be plain EOAs: `eth_getCode` is `0x`
 * until something assigns code (e.g. EIP-7702 delegation). Any non-empty code
 * counts as "used" for freshness heuristics.
 */
function hasNonEmptyCode(code: string): boolean {
  const c = code.trim().toLowerCase();
  return c !== "0x" && c !== "";
}

export async function isAddressUsed(
  address: string,
  client: KohakuPublicClient
): Promise<boolean> {
  const [nonce, balance, code] = await Promise.all([
    client.getTransactionCount({ address: address as `0x${string}` }),
    client.getBalance({ address: address as `0x${string}` }),
    client.getCode({ address: address as `0x${string}` }),
  ]);
  if (nonce > 0 || balance > 0n) {
    return true;
  }
  return hasNonEmptyCode(code ?? "0x");
}
