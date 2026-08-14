import type { Address } from "viem";

/** CLI protocol ids (map 1:1 onto ENS / GNS / WNS). */
export type NameProtocol = "ens" | "gns" | "wns";

export const NAME_PROTOCOLS = ["ens", "gns", "wns"] as const;

/** GNS NameNFT — same CREATE address on mainnet and Sepolia. */
export const GNS_CONTRACT =
  "0x9D51D507BC7264d4fE8Ad1cf7Fe191933A0a81d6" as Address;

/** WNS NameNFT (mainnet). */
export const WNS_CONTRACT =
  "0x0000000000696760E15f265e828DB644A0c242EB" as Address;

/**
 * namehash("gwei") — TLD node the contract uses when `parentId == 0`.
 * Do not pass this to `isAvailable` for top-level names; use parentId `0`.
 */
export const GWEI_NODE =
  "0xcca9c7f2dbe2808af0de2982fc84314bfa68a82a6a60ad5cd757f91a233d7d7f" as const;

/**
 * namehash("wei") — TLD node the contract uses when `parentId == 0`.
 * Do not pass this to `isAvailable` for top-level names; use parentId `0`.
 */
export const WEI_NODE =
  "0xa82820059d5df798546bcc2985157a77c3eef25eba9ba01899927333efacbd6f" as const;

/**
 * ENS v1 mainnet contracts (not Sepolia ENSv2).
 * Addresses: docs.ens.domains + ensdomains/ens-contracts deployments.
 * Controller ABI matches EP3.5 (`master` deployment); Public Resolver is the
 * current default from `staging` deployments (set on new registrations).
 */
export const ENS_ETH_REGISTRAR_CONTROLLER =
  "0x253553366Da8546fC250F225fe3d25d0C782303b" as Address;
export const ENS_PUBLIC_RESOLVER =
  "0xF29100983E058B709F3D539b0c765937B804AC15" as Address;
export const ENS_REGISTRY =
  "0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e" as Address;
/** BaseRegistrarImplementation — .eth ERC-721 (not the viral empty FdC8 lookalike). */
export const ENS_BASE_REGISTRAR =
  "0x57f1887a8BF19b14fC0dF6Fd9B2acc9Af147eA85" as Address;
export const ENS_NAME_WRAPPER =
  "0xD4416b13d2b3a9aBae7AcD5D6C2BbDBE25686401" as Address;
export const ENS_REVERSE_REGISTRAR =
  "0xa58E81fe9b61B5c3fE2AFD33CF304c454AbFc7Cb" as Address;
/** Canonical resolution entrypoint (DAO-owned proxy). Libraries should prefer this. */
export const ENS_UNIVERSAL_RESOLVER =
  "0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe" as Address;

/** Min wait between commit and reveal/register, in seconds (all three systems). */
export const MIN_COMMITMENT_AGE_SECONDS = 60n;

/** Default registration / renewal duration for ENS (1 year). */
export const ONE_YEAR_SECONDS = 31_536_000n;

export const PROTOCOL_META: Record<
  NameProtocol,
  { tld: ".eth" | ".gwei" | ".wei"; label: string }
> = {
  ens: { tld: ".eth", label: "ENS" },
  gns: { tld: ".gwei", label: "GNS" },
  wns: { tld: ".wei", label: "WNS" },
};
