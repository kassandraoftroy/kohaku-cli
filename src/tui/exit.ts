/** Set by {@link runTui} — unmounts Ink instead of `process.exit` so the terminal restores. */
let exitImpl: (() => void) | null = null;

export function registerTuiExit(fn: () => void): void {
  exitImpl = fn;
}

export function clearTuiExit(): void {
  exitImpl = null;
}

export function requestTuiExit(): void {
  exitImpl?.();
}
