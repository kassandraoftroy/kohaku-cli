import { log } from "@clack/prompts";
import chalk from "chalk";

/** tor-js / Arti bootstrap failures of the form `Bootstrap failed: tor: …`. */
const TOR_BOOTSTRAP_FAILED_RE = /Bootstrap failed:\s*tor:/i;

/**
 * Append a recovery hint for Tor persistent-state / bootstrap failures.
 * Safe to call on any error string (no-op when unrelated).
 */
export function withTorBootstrapHint(message: string): string {
  if (!TOR_BOOTSTRAP_FAILED_RE.test(message)) return message;
  if (/clear-tor-cache/i.test(message)) return message;
  return `${message.trimEnd()}\n  → Try: kohaku clear-tor-cache`;
}

/**
 * Standard CLI failure: red ✖ line via clack, `process.exitCode = 1`.
 * Pass the message without a leading `✖` (it is added unless already present).
 */
export function cliError(message: string): void {
  const m = withTorBootstrapHint(message.trimStart());
  const line = m.startsWith("✖") ? m : `✖ ${m}`;
  log.error(chalk.red(line));
  process.exitCode = 1;
}

export function cliErrorFromCaught(e: unknown): void {
  if (e instanceof Error) {
    cliError(e.message);
  } else if (typeof e === "object" && e !== null) {
    try {
      cliError(JSON.stringify(e, null, 2));
    } catch {
      cliError(String(e));
    }
  } else {
    cliError(String(e));
  }
}
