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

/** namehash("gwei") — parent node / TLD id for top-level .gwei names. */
export const GWEI_NODE =
  "0xcca9c7f2dbe2808af0de2982fc84314bfa68a82a6a60ad5cd757f91a233d7d7f" as const;

/** namehash("wei") — parent node / TLD id for top-level .wei names. */
export const WEI_NODE =
  "0xa82820059d5df798546bcc2985157a77c3eef25eba9ba01899927333efacbd6f" as const;

/** ENS v1 (Name Wrapper era) mainnet contracts — not Sepolia ENS v2. */
export const ENS_ETH_REGISTRAR_CONTROLLER =
  "0x253553366Da8546fC250F225fe3d25d0C782303b" as Address;
export const ENS_PUBLIC_RESOLVER =
  "0x231b0Ee14048e9dCcD1d247744d114a4EB5E8E63" as Address;
export const ENS_REGISTRY =
  "0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e" as Address;
export const ENS_BASE_REGISTRAR =
  "0x57f1887a8BF19b14fC0dFCbdcbF8A8314E00FdC8" as Address;
export const ENS_NAME_WRAPPER =
  "0xD4416b13d2b3a9aBae7AcD5D6C2BbDBE25686401" as Address;
export const ENS_REVERSE_REGISTRAR =
  "0xa58E81fe9b61B5c3fE2AFD33CF304c454AbFc7Cb" as Address;

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
