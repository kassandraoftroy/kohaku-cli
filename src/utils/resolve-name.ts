/**
 * ENS / GNS / WNS name resolution via @1001-digital/ethereum-names.
 *
 * Accepted inputs:
 *   - A plain `0x…` Ethereum address  → returned checksummed, no network call.
 *   - A name ending in `.eth`         → resolved via ENS.
 *   - A name ending in `.gwei`        → resolved via GNS.
 *   - A name ending in `.wei`         → resolved via WNS.
 *
 * Any other input (including bare labels with no recognised TLD) throws so
 * we never silently forward an un-resolved or misspelled identifier to a
 * transaction.
 */

import { getAddress, isAddress } from "viem";
import { createEthereumNames } from "@1001-digital/ethereum-names";

const SUPPORTED_TLDS = [".eth", ".gwei", ".wei"] as const;

function hasNameTld(value: string): boolean {
  const lower = value.toLowerCase();
  return SUPPORTED_TLDS.some((tld) => lower.endsWith(tld));
}

/**
 * Resolve a name or pass through an address.
 *
 * @param input - A raw CLI argument that should be an Ethereum address or a
 *   name with a recognised TLD (`.eth`, `.gwei`, `.wei`).
 * @param rpcUrl - **Required** when `input` is a name. Must be a mainnet RPC
 *   endpoint (ENS, GNS, and WNS all live on Ethereum mainnet). Passing
 *   `undefined` when a name needs resolving throws an explicit error rather
 *   than silently falling back to the library's bundled public RPC (which
 *   would leak the name to an uncontrolled third party and bypass Tor).
 * @returns The checksummed `0x…` address.
 * @throws If the input is not a valid address and has no supported TLD, if no
 *   `rpcUrl` is provided for a name, or if resolution returns null.
 */
export async function resolveAddressOrName(
  input: string,
  rpcUrl?: string
): Promise<`0x${string}`> {
  const trimmed = input.trim();

  // Plain address — no network call needed.
  if (isAddress(trimmed)) {
    return getAddress(trimmed) as `0x${string}`;
  }

  if (!hasNameTld(trimmed)) {
    throw new Error(
      `"${trimmed}" is not a valid Ethereum address. ` +
        `To use a name, it must end with .eth, .gwei, or .wei.`
    );
  }

  if (!rpcUrl) {
    throw new Error(
      `Name resolution for "${trimmed}" requires an RPC URL. ` +
        `Provide --rpc-url (or set RPC_URL) pointing to an Ethereum mainnet node.`
    );
  }

  const names = createEthereumNames({ rpcUrl });
  const resolved = await names.resolve(trimmed);

  if (!resolved) {
    throw new Error(
      `Name "${trimmed}" could not be resolved to an Ethereum address. ` +
        `Make sure it is registered and points to an account.`
    );
  }

  return getAddress(resolved) as `0x${string}`;
}

/**
 * Like `resolveAddressOrName` but returns `null` instead of throwing when the
 * input is already a plain address, so callers can tell the difference between
 * "was already an address" and "resolved from name" when they need to.
 *
 * In most cases you want `resolveAddressOrName` instead.
 */
export async function maybeResolveName(
  input: string,
  rpcUrl?: string
): Promise<{ address: `0x${string}`; resolvedFrom?: string }> {
  const trimmed = input.trim();
  if (isAddress(trimmed)) {
    return { address: getAddress(trimmed) as `0x${string}` };
  }
  const address = await resolveAddressOrName(trimmed, rpcUrl);
  return { address, resolvedFrom: trimmed };
}

/** Quick synchronous check: is this string a name we would attempt to resolve? */
export function looksLikeName(value: string): boolean {
  return !isAddress(value.trim()) && hasNameTld(value.trim());
}
