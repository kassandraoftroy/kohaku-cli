import {
  ERC5564_CONTRACT_ADDRESS,
  ERC6538_CONTRACT_ADDRESS,
} from "@scopelift/stealth-address-sdk/dist/config/contractAddresses.js";
import { ERC5564_StartBlocks } from "@scopelift/stealth-address-sdk/dist/config/startBlocks.js";

/** ENS/GNS/WNS text record key for the scheme-1 stealth meta-address. */
export const STEALTH_TEXT_RECORD_KEY = "stealth-address-scheme-1";

/** BIP-44-ish paths for stealth spending / viewing keys (coin-type 60, purpose slot 5564). */
export const STEALTH_SPENDING_PATH = "m/44'/60'/0'/5564'/1'/0'" as const;
export const STEALTH_VIEWING_PATH = "m/44'/60'/0'/5564'/1'/1'" as const;

/** EIP-5564 scheme id 1 (SECP256k1). */
export const STEALTH_SCHEME_ID = 1 as const;

export const STEALTH_ANNOUNCER_ADDRESS =
  ERC5564_CONTRACT_ADDRESS as `0x${string}`;

/** Canonical EIP-6538 stealth meta-address registry (same address on mainnet/Sepolia). */
export const STEALTH_REGISTRY_ADDRESS =
  ERC6538_CONTRACT_ADDRESS as `0x${string}`;

export function stealthAnnouncerStartBlock(chainId: bigint): bigint {
  if (chainId === 1n) return BigInt(ERC5564_StartBlocks.MAINNET);
  if (chainId === 11155111n) return BigInt(ERC5564_StartBlocks.SEPOLIA);
  return 0n;
}

/** EIP-3770 chain short name used in `st:<chain>:…` URIs. */
export function stealthChainShortName(chainId: bigint): "eth" | "sep" {
  return chainId === 11155111n ? "sep" : "eth";
}
