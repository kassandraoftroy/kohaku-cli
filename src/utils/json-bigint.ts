/** JSON.stringify with bigint → decimal string (for CLI payloads). */
export function jsonStringifyWithBigInt(value: unknown, space?: number): string {
  return JSON.stringify(
    value,
    (_key, v) => (typeof v === "bigint" ? v.toString() : v),
    space
  );
}
