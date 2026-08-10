import {
  STEALTH_REGISTRY_ADDRESS,
  STEALTH_SCHEME_ID,
  lookupStealthMetaAddressFromRegistry,
  normalizeStealthMetaAddressURI,
} from "eth-stealth-address-resolver";
import { encodeFunctionData, type Address, type Hex } from "viem";

import type { PreparedTx } from "../names/types.js";
import type { KohakuPublicClient } from "../../utils/rpc.js";

const ERC6538_REGISTER_ABI = [
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
] as const;

/** Prepare ERC-6538 `registerKeys(schemeId, stealthMetaAddress)` for the signer. */
export function prepareRegisterStealthKeys(opts: {
  stealthMetaAddress: Hex;
  /** Registrant EOA that will send the tx (must match msg.sender). */
  account: Address;
}): PreparedTx {
  const data = encodeFunctionData({
    abi: ERC6538_REGISTER_ABI,
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
