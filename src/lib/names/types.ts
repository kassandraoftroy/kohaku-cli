import type { Address, Hex } from "viem";

import type { NameProtocol } from "./constants.js";

export type PreparedTx = {
  to: Address;
  data: Hex;
  value: bigint;
  /** Human label for logs / confirms (e.g. "commit", "reveal"). */
  step: string;
};

export type ParsedName = {
  /** Full name including TLD, lowercased ASCII for gns/wns; ENS-normalized for ens. */
  name: string;
  /** Single label without TLD (no dots). */
  label: string;
  protocol: NameProtocol;
};

export type NameOwnership = {
  /** NFT registrant / wrapped owner (who can transfer / renew as owner). */
  owner: Address;
  /**
   * ENS registry owner ("manager") who can update records.
   * For GNS/WNS this equals `owner` (no separate manager role).
   */
  manager: Address;
  /** True when ENS name is wrapped in NameWrapper. Always false for GNS/WNS. */
  wrapped: boolean;
  /** ENS namehash / GNS-WNS token id as uint256 bits. */
  node: Hex;
  /** GNS/WNS ERC-721 token id. Undefined for ENS. */
  tokenId?: bigint;
};

export type TransferRole = "owner" | "manager" | "both";
