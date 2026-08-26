import {
  ERC5564_CONTRACT_ADDRESS,
} from "@scopelift/stealth-address-sdk/dist/config/contractAddresses.js";
import { ERC5564_StartBlocks } from "@scopelift/stealth-address-sdk/dist/config/startBlocks.js";

/** BIP-44-ish paths for stealth spending / viewing keys (coin-type 60, purpose slot 5564). */
export const STEALTH_SPENDING_PATH = "m/44'/60'/0'/5564'/1'/0'" as const;
export const STEALTH_VIEWING_PATH = "m/44'/60'/0'/5564'/1'/1'" as const;

/**
 * Hardened BIP-32 segment under purpose 5564 that is **not** a stealth scheme
 * id. Tornado's paymaster API only accepts `{ mode: "deterministic", path }`,
 * so the CLI uses this sentinel so `Host.keystore.deriveAt` can return a stored
 * payment stealth private key instead of HD-deriving.
 *
 * Full path: `{STEALTH_ADDRESS_MAGIC_VALUE_PATH}/{stealthIndex}` (e.g. s0 →
 * `m/44'/60'/0'/5564'/9981'/0`).
 */
export const STEALTH_ADDRESS_MAGIC_VALUE = 9981;

/** Prefix (no stealth index) for Tornado 7702 injection of stored stealth keys. */
export const STEALTH_ADDRESS_MAGIC_VALUE_PATH =
  `m/44'/60'/0'/5564'/${STEALTH_ADDRESS_MAGIC_VALUE}'` as const;

/** BIP-32-shaped path Tornado uses as the batch 7702 for stored stealth `sN`. */
export function stealthDelegatorPath(stealthIndex: number): string {
  if (!Number.isSafeInteger(stealthIndex) || stealthIndex < 0) {
    throw new Error(`Invalid stealth account index: ${stealthIndex}`);
  }
  return `${STEALTH_ADDRESS_MAGIC_VALUE_PATH}/${stealthIndex}`;
}

/**
 * Inverse of {@link stealthDelegatorPath}. Returns null for public HD paths,
 * stealth meta keys (`5564'/1'/…`), and anything else.
 */
export function parseStealthDelegatorPath(path: string): number | null {
  const prefix = `${STEALTH_ADDRESS_MAGIC_VALUE_PATH}/`;
  if (!path.startsWith(prefix)) return null;
  const rest = path.slice(prefix.length);
  const m = /^(\d+)$/.exec(rest);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isSafeInteger(n) || n < 0) return null;
  return n;
}

export const STEALTH_ANNOUNCER_ADDRESS =
  ERC5564_CONTRACT_ADDRESS as `0x${string}`;

export function stealthAnnouncerStartBlock(chainId: bigint): bigint {
  if (chainId === 1n) return BigInt(ERC5564_StartBlocks.MAINNET);
  if (chainId === 11155111n) return BigInt(ERC5564_StartBlocks.SEPOLIA);
  return 0n;
}

/**
 * Optimistic first-scan floor for Kohaku-schema stealth keys.
 *
 * The ERC-5564 announcer is older than this CLI's derivation scheme; imports
 * that omit `--stealth-start-block` start here instead of at contract deploy.
 * `balances --stealth-start-block` can still back-date down to
 * {@link stealthAnnouncerStartBlock}.
 */
export function defaultStealthImportStartBlock(chainId: bigint): bigint {
  if (chainId === 1n) return 25_700_000n;
  if (chainId === 11155111n) return 11_455_454n;
  return 0n;
}
