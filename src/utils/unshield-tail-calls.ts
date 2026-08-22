import { getAddress, isAddress } from "viem";

import type { UnshieldTailCall } from "./plugins.js";

/**
 * Parse `--tail-calls` as comma-separated `TARGET:CALLDATA` or
 * `TARGET:CALLDATA:VALUE` entries (decimal wei or 0x-hex value).
 */
export function parseTailCalls(raw: string): UnshieldTailCall[] {
  const entries = raw.split(",").map((entry) => entry.trim());
  if (entries.length === 0 || entries.some((entry) => !entry)) {
    throw new Error(
      "--tail-calls must contain comma-separated TARGET:CALLDATA or TARGET:CALLDATA:VALUE entries."
    );
  }

  return entries.map((entry, index) => {
    const parts = entry.split(":").map((part) => part.trim());
    if (parts.length < 2 || parts.length > 3 || parts.some((part) => !part)) {
      throw new Error(
        `Invalid tail call at index ${index}: expected TARGET:CALLDATA or TARGET:CALLDATA:VALUE.`
      );
    }

    const [target, data, valueRaw] = parts;
    if (!isAddress(target!)) {
      throw new Error(`Invalid tail call target at index ${index}: ${target}`);
    }
    if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(data!)) {
      throw new Error(
        `Invalid tail call calldata at index ${index}: expected 0x-prefixed, byte-aligned hex.`
      );
    }

    let value = 0n;
    if (valueRaw !== undefined) {
      if (!/^0x[0-9a-fA-F]+$/.test(valueRaw) && !/^[0-9]+$/.test(valueRaw)) {
        throw new Error(
          `Invalid tail call value at index ${index}: expected 0x-hex or decimal wei (${valueRaw}).`
        );
      }
      try {
        value = BigInt(valueRaw);
      } catch {
        throw new Error(
          `Invalid tail call value at index ${index}: ${valueRaw}`
        );
      }
      if (value < 0n) {
        throw new Error(`Invalid tail call value at index ${index}: must be >= 0.`);
      }
    }

    return {
      to: getAddress(target!) as `0x${string}`,
      data: data! as `0x${string}`,
      value,
    };
  });
}
