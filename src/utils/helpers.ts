import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_DATA_DIR = join(homedir(), ".kohaku-cli");

export function walletNameToDirSegment(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new Error("Wallet name cannot be empty");
  }
  const safe = trimmed.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  if (!safe) {
    throw new Error(
      "Wallet name must contain at least one letter, digit, dot, hyphen, or underscore"
    );
  }
  return safe;
}