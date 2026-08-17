import { inspect } from "node:util";

import { log } from "@clack/prompts";
import chalk from "chalk";

/** tor-js / Arti bootstrap failures of the form `Bootstrap failed: tor: …`. */
const TOR_BOOTSTRAP_FAILED_RE = /Bootstrap failed:\s*tor:/i;

const USELESS_OBJECT_STRING_RE = /^\[object \w+]$/;

function isUselessText(s: string): boolean {
  const t = s.trim();
  return t.length === 0 || USELESS_OBJECT_STRING_RE.test(t);
}

function inspectValue(value: unknown): string {
  return inspect(value, {
    depth: 6,
    colors: false,
    compact: false,
    maxArrayLength: 20,
    maxStringLength: 800,
    breakLength: 80,
  });
}

const ERROR_EXTRA_KEYS = [
  "code",
  "shortMessage",
  "details",
  "data",
  "status",
  "url",
  "method",
  "error",
  "reason",
  "info",
  "metaMessages",
] as const;

/**
 * Human-readable text for a thrown value. Plain objects (JSON-RPC bodies,
 * WASM/plugin payloads) otherwise stringify as `[object Object]`.
 */
export function formatCaughtError(err: unknown): string {
  if (err === undefined) return "undefined";
  if (err === null) return "null";
  if (typeof err === "string") return err;
  if (
    typeof err === "number" ||
    typeof err === "boolean" ||
    typeof err === "bigint"
  ) {
    return String(err);
  }

  if (err instanceof Error) {
    const bag = err as unknown as Record<string, unknown>;
    const parts: string[] = [];
    if (!isUselessText(err.message)) {
      parts.push(err.message);
    } else if (
      typeof bag.shortMessage === "string" &&
      !isUselessText(bag.shortMessage)
    ) {
      parts.push(bag.shortMessage);
    } else {
      parts.push(err.name || "Error");
    }

    const extra: Record<string, unknown> = {};
    for (const key of ERROR_EXTRA_KEYS) {
      if (!(key in err)) continue;
      const v = bag[key];
      if (v === undefined) continue;
      if (key === "shortMessage" && v === err.message) continue;
      extra[key] = v;
    }
    for (const [k, v] of Object.entries(err)) {
      if (k === "message" || k === "name" || k === "stack" || k in extra) continue;
      extra[k] = v;
    }
    if (Object.keys(extra).length > 0) {
      parts.push(inspectValue(extra));
    }
    if (err.cause !== undefined) {
      parts.push(`cause: ${formatCaughtError(err.cause)}`);
    }
    if (err instanceof AggregateError && err.errors.length > 0) {
      parts.push(
        `errors: ${err.errors.map((e) => formatCaughtError(e)).join("; ")}`
      );
    }
    return parts.join("\n");
  }

  if (typeof err === "object") {
    const rec = err as Record<string, unknown>;
    const leadCandidates = [rec.message, rec.shortMessage, rec.details];
    let lead = "";
    for (const c of leadCandidates) {
      if (typeof c === "string" && !isUselessText(c)) {
        lead = c;
        break;
      }
    }
    const dumped = inspectValue(err);
    return lead && dumped !== lead ? `${lead}\n${dumped}` : dumped;
  }

  return inspectValue(err);
}

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
  cliError(formatCaughtError(e));
}
