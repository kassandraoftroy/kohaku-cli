import { statSync } from "node:fs";

/** Includes replacement and in-place edits, even when size and mtime are preserved. */
export function fileFingerprint(path: string): string | null {
  try {
    const stat = statSync(path, { bigint: true });
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
  } catch { return null; }
}
