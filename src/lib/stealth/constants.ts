import {
  ERC5564_CONTRACT_ADDRESS,
} from "@scopelift/stealth-address-sdk/dist/config/contractAddresses.js";
import { ERC5564_StartBlocks } from "@scopelift/stealth-address-sdk/dist/config/startBlocks.js";

/** BIP-44-ish paths for stealth spending / viewing keys (coin-type 60, purpose slot 5564). */
export const STEALTH_SPENDING_PATH = "m/44'/60'/0'/5564'/1'/0'" as const;
export const STEALTH_VIEWING_PATH = "m/44'/60'/0'/5564'/1'/1'" as const;

export const STEALTH_ANNOUNCER_ADDRESS =
  ERC5564_CONTRACT_ADDRESS as `0x${string}`;

export function stealthAnnouncerStartBlock(chainId: bigint): bigint {
  if (chainId === 1n) return BigInt(ERC5564_StartBlocks.MAINNET);
  if (chainId === 11155111n) return BigInt(ERC5564_StartBlocks.SEPOLIA);
  return 0n;
}
