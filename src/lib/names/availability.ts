import { getAddress, type Address, zeroAddress } from "viem";

import type { KohakuPublicClient } from "../../utils/rpc.js";
import {
  ENS_ETH_REGISTRAR_CONTROLLER,
} from "./constants.js";
import { ENS_CONTROLLER_ABI, NAME_NFT_ABI } from "./abis.js";
import {
  assertEnsMainnet,
  nftContract,
  nftParentId,
  readNameOwnership,
} from "./ops.js";
import type { ParsedName } from "./types.js";

export type NameProbeStatus = "available" | "owned-by-us" | "unavailable";

function ownedByRegistrant(
  ownership: { owner: Address; manager: Address },
  registrant: Address
): boolean {
  const want = getAddress(registrant).toLowerCase();
  return (
    ownership.owner.toLowerCase() === want ||
    ownership.manager.toLowerCase() === want
  );
}

/**
 * Probe whether a name is free to register, already owned by `registrant`,
 * or unavailable (taken by someone else / unprobeable).
 */
export async function probeNameStatus(opts: {
  client: KohakuPublicClient;
  parsed: ParsedName;
  registrant: Address;
}): Promise<NameProbeStatus> {
  const { client, parsed, registrant } = opts;

  if (parsed.protocol === "ens") {
    try {
      assertEnsMainnet(BigInt(client.chain?.id ?? 0));
    } catch {
      return "unavailable";
    }
    try {
      const available = await client.readContract({
        address: ENS_ETH_REGISTRAR_CONTROLLER,
        abi: ENS_CONTROLLER_ABI,
        functionName: "available",
        args: [parsed.label],
      });
      if (available) return "available";
    } catch {
      return "unavailable";
    }
    try {
      const ownership = await readNameOwnership(client, parsed);
      if (ownedByRegistrant(ownership, registrant)) return "owned-by-us";
    } catch {
      // Taken but ownership unreadable — treat as unavailable.
    }
    return "unavailable";
  }

  const contract = nftContract(parsed.protocol);
  const parentId = nftParentId(parsed.protocol);
  try {
    const available = await client.readContract({
      address: contract,
      abi: NAME_NFT_ABI,
      functionName: "isAvailable",
      args: [parsed.label, parentId],
    });
    if (available) return "available";
  } catch {
    return "unavailable";
  }

  try {
    const ownership = await readNameOwnership(client, parsed);
    if (ownership.owner === zeroAddress) return "unavailable";
    if (ownedByRegistrant(ownership, registrant)) return "owned-by-us";
  } catch {
    // ownerOf reverts when unminted / burned edge cases
  }
  return "unavailable";
}
