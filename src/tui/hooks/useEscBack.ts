import { useInput } from "ink";

/** Esc returns to the main menu (or parent onCancel). Skipped while `disabled`. */
export function useEscBack(onBack: () => void, disabled = false): void {
  useInput((_, key) => {
    if (key.escape && !disabled) onBack();
  });
}

export function shortenAddr(addr: string): string {
  if (addr.length < 14) return addr;
  return `${addr.slice(0, 8)}…${addr.slice(-6)}`;
}
