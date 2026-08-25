import { jsonStringifyWithBigInt } from "./json-bigint";
import {
  clearTerminalOwner,
  setTerminalOwner,
  type TerminalOwner,
} from "./progress-terminal.js";

/**
 * With `--non-interactive`, skip clack spinners and similar UI so stdout stays
 * machine-readable (JSON). Errors and required-flag validation still apply.
 */
export function quietNonInteractive(nonInteractive?: boolean): boolean {
  return !!nonInteractive;
}

/** Minimal spinner surface from `@clack/prompts` `spinner()`. */
export type QuietSpinner = {
  start: (msg?: string) => void;
  stop: (msg?: string, code?: number) => void;
  message?: (msg?: string) => void;
};

/**
 * Wraps a clack spinner so repeated `start()` calls update the message instead
 * of leaking intervals. Clack's `start()` does not `clearInterval` the previous
 * tick, which leaves frames rewriting the last line over later prompts.
 */
export function manageSpinner(
  spin: QuietSpinner,
  quiet: boolean
): QuietSpinner & { readonly active: boolean } & TerminalOwner {
  let active = false;
  let lastMessage: string | undefined;

  const managed = {
    get active() {
      return active;
    },
    start(msg?: string) {
      if (quiet) return;
      lastMessage = msg ?? lastMessage;
      if (active) {
        spin.message?.(msg);
        return;
      }
      spin.start(msg);
      active = true;
      setTerminalOwner(managed);
    },
    message(msg?: string) {
      if (quiet || !active) return;
      lastMessage = msg ?? lastMessage;
      spin.message?.(msg);
    },
    stop(msg?: string, code?: number) {
      if (quiet || !active) return;
      spin.stop(msg, code);
      active = false;
      clearTerminalOwner(managed);
    },
    /** Yields the terminal line; see `progress-terminal`. */
    suspend(): string | null {
      if (quiet || !active) return null;
      spin.stop("");
      active = false;
      // clack's stop() leaves a bare "◇" line behind; drop it so whoever takes
      // the line starts clean.
      if (process.stdout.isTTY) {
        process.stdout.write("\u001b[1A\u001b[2K\u001b[999D");
      }
      return lastMessage ?? "";
    },
    resume(msg: string | null): void {
      if (quiet) return;
      managed.start(msg ?? lastMessage);
    },
  };

  return managed;
}

/**
 * Runs `fn` with optional spinner start/stop when not in quiet (non-interactive) mode.
 * On failure: stops with `labels.failure` and exit code 1, then rethrows.
 */
export async function runQuietSpinner<T>(
  quiet: boolean,
  spin: QuietSpinner,
  labels: { start: string; failure: string },
  fn: () => Promise<T>,
  stopSuccess: (result: T) => string
): Promise<T> {
  if (!quiet) spin.start(labels.start);
  try {
    const result = await fn();
    if (!quiet) spin.stop(stopSuccess(result));
    return result;
  } catch (err) {
    if (!quiet) spin.stop(labels.failure, 1);
    throw err;
  }
}

/** One JSON line to stdout (BigInt-safe). */
export function logCliJson(value: unknown, space?: number): void {
  console.log(jsonStringifyWithBigInt(value, space));
}
