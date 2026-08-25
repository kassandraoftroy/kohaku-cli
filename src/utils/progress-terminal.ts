/**
 * Tracks which spinner currently owns the terminal line.
 *
 * A clack spinner erases everything below its cursor on every frame, so a
 * second animator cannot share the screen with it. Sync progress needs to take
 * the line over for the duration of a sync (see `sync-progress-renderer`), and
 * this registry lets it do so without threading spinner objects through the
 * library APIs that sit between a command and its sync.
 *
 * One process draws to one terminal, so a single slot is enough.
 */
export type TerminalOwner = {
  /** Stops drawing and returns the message to restore with, or `null` if idle. */
  suspend(): string | null;
  resume(message: string | null): void;
};

let active: TerminalOwner | null = null;

export function setTerminalOwner(owner: TerminalOwner): void {
  active = owner;
}

export function clearTerminalOwner(owner: TerminalOwner): void {
  if (active === owner) active = null;
}

/**
 * Suspends the current owner so the caller can draw. Returns a restore function,
 * or `null` when nothing held the line.
 */
export function takeTerminal(): (() => void) | null {
  const owner = active;
  if (!owner) return null;
  const restore = owner.suspend();
  if (restore === null) return null;
  return () => owner.resume(restore);
}
