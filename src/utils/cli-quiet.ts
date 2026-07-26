import { jsonStringifyWithBigInt } from "./json-bigint";

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
): QuietSpinner & { readonly active: boolean } {
  let active = false;
  return {
    get active() {
      return active;
    },
    start(msg?: string) {
      if (quiet) return;
      if (active) {
        spin.message?.(msg);
        return;
      }
      spin.start(msg);
      active = true;
    },
    message(msg?: string) {
      if (quiet || !active) return;
      spin.message?.(msg);
    },
    stop(msg?: string, code?: number) {
      if (quiet || !active) return;
      spin.stop(msg, code);
      active = false;
    },
  };
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
