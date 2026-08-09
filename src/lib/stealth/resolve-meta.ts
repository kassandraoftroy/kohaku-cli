import { createEthereumNames } from "@1001-digital/ethereum-names";
import { getAddress, isAddress, type Address } from "viem";

import { makePublicClient, disposePublicClient } from "../../utils/rpc.js";
import { looksLikeName } from "../../utils/resolve-name.js";
import { STEALTH_TEXT_RECORD_KEY } from "./constants.js";
import {
  looksLikeStealthMetaAddress,
  normalizeStealthMetaAddressURI,
} from "./keys.js";
import { lookupStealthMetaAddressFromRegistry } from "./registry.js";

export type ResolvedStealthMeta = {
  uri: string;
  /** How the meta-address was found. */
  source: "meta" | "text" | "registry";
  /** Name used for a successful text-record lookup, if any. */
  name?: string;
  /** Address used for registry lookup / name resolution. */
  registrant?: Address;
};

const NO_SCHEME1 =
  "no scheme 1 stealth meta address found";

async function textRecordMeta(
  names: ReturnType<typeof createEthereumNames>,
  name: string,
  chainId: bigint
): Promise<string | null> {
  try {
    const text = await names.getText(name, STEALTH_TEXT_RECORD_KEY);
    if (!text?.trim()) return null;
    return normalizeStealthMetaAddressURI(text.trim(), chainId);
  } catch {
    return null;
  }
}

/**
 * Resolve a scheme-1 stealth meta-address for `--stealth --to <…>`.
 *
 * Priority:
 * 1. Raw meta (`st:…` / `0x`+132 hex)
 * 2. Name → `stealth-address-scheme-1` text record; else ERC-6538 for resolved addr
 * 3. Address → reverse (ENS→GNS→WNS) text record; else ERC-6538 for the address
 */
export async function resolveScheme1StealthMetaAddress(opts: {
  to: string;
  rpcUrl: string;
  chainId: bigint;
}): Promise<ResolvedStealthMeta> {
  const to = opts.to.trim();
  if (!to) {
    throw new Error(NO_SCHEME1);
  }

  if (looksLikeStealthMetaAddress(to)) {
    return {
      uri: normalizeStealthMetaAddressURI(to, opts.chainId),
      source: "meta",
    };
  }

  const names = createEthereumNames({
    rpcUrl: opts.rpcUrl,
    reversePriority: ["ens", "gns", "wns"],
  });
  const client = await makePublicClient(opts.rpcUrl);
  try {
    if (looksLikeName(to)) {
      const fromText = await textRecordMeta(names, to, opts.chainId);
      if (fromText) {
        return { uri: fromText, source: "text", name: to };
      }
      let registrant: Address;
      try {
        const resolvedAddr = await names.resolve(to);
        if (!resolvedAddr) throw new Error(NO_SCHEME1);
        registrant = getAddress(resolvedAddr);
      } catch {
        throw new Error(NO_SCHEME1);
      }
      const fromRegistry = await lookupStealthMetaAddressFromRegistry({
        client,
        registrant,
        chainId: opts.chainId,
      });
      if (fromRegistry) {
        return {
          uri: fromRegistry,
          source: "registry",
          name: to,
          registrant,
        };
      }
      throw new Error(NO_SCHEME1);
    }

    if (isAddress(to)) {
      const registrant = getAddress(to);
      let primary: string | null = null;
      try {
        primary = await names.reverse(registrant);
      } catch {
        primary = null;
      }
      if (primary) {
        const fromText = await textRecordMeta(names, primary, opts.chainId);
        if (fromText) {
          return {
            uri: fromText,
            source: "text",
            name: primary,
            registrant,
          };
        }
      }
      const fromRegistry = await lookupStealthMetaAddressFromRegistry({
        client,
        registrant,
        chainId: opts.chainId,
      });
      if (fromRegistry) {
        return {
          uri: fromRegistry,
          source: "registry",
          name: primary ?? undefined,
          registrant,
        };
      }
      throw new Error(NO_SCHEME1);
    }

    throw new Error(NO_SCHEME1);
  } finally {
    disposePublicClient(client);
  }
}
