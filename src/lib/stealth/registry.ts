import {
  encodeFunctionData,
  getAddress,
  type Address,
  type Hex,
} from "viem";

import type { PreparedTx } from "../names/types.js";
import type { KohakuPublicClient } from "../../utils/rpc.js";
import {
  STEALTH_REGISTRY_ADDRESS,
  STEALTH_SCHEME_ID,
} from "./constants.js";
import {
  looksLikeStealthMetaAddress,
  normalizeStealthMetaAddressURI,
} from "./keys.js";

const ERC6538_ABI = [
  {
    type: "function",
    name: "registerKeys",
    stateMutability: "nonpayable",
    inputs: [
      { name: "schemeId", type: "uint256" },
      { name: "stealthMetaAddress", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "stealthMetaAddressOf",
    stateMutability: "view",
    inputs: [
      { name: "registrant", type: "address" },
      { name: "schemeId", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bytes" }],
  },
] as const;

/** True when registry bytes look like a scheme-1 meta (two compressed pubs). */
export function isScheme1StealthMetaBytes(value: string | null | undefined): boolean {
  if (!value) return false;
  const v = value.trim();
  if (v === "" || v === "0x") return false;
  return /^0x[0-9a-fA-F]{132}$/.test(v);
}

/**
 * Read scheme-1 stealth meta-address for a registrant from ERC-6538.
 * Returns a normalized `st:<chain>:0x…` URI, or null when unset / invalid.
 */
export async function lookupStealthMetaAddressFromRegistry(opts: {
  client: KohakuPublicClient;
  registrant: Address;
  chainId: bigint;
}): Promise<string | null> {
  const registrant = getAddress(opts.registrant);
  const raw = (await opts.client.readContract({
    address: STEALTH_REGISTRY_ADDRESS,
    abi: ERC6538_ABI,
    functionName: "stealthMetaAddressOf",
    args: [registrant, BigInt(STEALTH_SCHEME_ID)],
  })) as Hex;

  if (!isScheme1StealthMetaBytes(raw)) return null;
  if (!looksLikeStealthMetaAddress(raw)) return null;
  return normalizeStealthMetaAddressURI(raw, opts.chainId);
}

/** Prepare ERC-6538 `registerKeys(schemeId, stealthMetaAddress)` for the signer. */
export function prepareRegisterStealthKeys(opts: {
  stealthMetaAddress: Hex;
  /** Registrant EOA that will send the tx (must match msg.sender). */
  account: Address;
}): PreparedTx {
  const data = encodeFunctionData({
    abi: ERC6538_ABI,
    functionName: "registerKeys",
    args: [BigInt(STEALTH_SCHEME_ID), opts.stealthMetaAddress],
  });
  return {
    to: STEALTH_REGISTRY_ADDRESS,
    data,
    value: 0n,
    step: "registerKeys",
  };
}

/**
 * Skip `registerKeys` when the registry already has this exact scheme-1 meta.
 */
export async function needsStealthRegistryUpdate(opts: {
  client: KohakuPublicClient;
  registrant: Address;
  stealthMetaAddress: Hex;
  chainId: bigint;
}): Promise<boolean> {
  const existing = await lookupStealthMetaAddressFromRegistry({
    client: opts.client,
    registrant: opts.registrant,
    chainId: opts.chainId,
  });
  if (!existing) return true;
  const want = normalizeStealthMetaAddressURI(
    opts.stealthMetaAddress,
    opts.chainId
  ).toLowerCase();
  return existing.toLowerCase() !== want;
}
