import { useInput } from "ink";

import { useFocus } from "../context/FocusContext.js";

/** Esc returns to the main menu (or parent onCancel). Skipped while `disabled`. */
export function useEscBack(onBack: () => void, disabled = false): void {
  const { focusMain } = useFocus();
  useInput((_, key) => {
    if (key.escape && !disabled && focusMain) onBack();
  }, { isActive: focusMain && !disabled });
}

export function shortenAddr(addr: string): string {
  if (addr.length < 14) return addr;
  return `${addr.slice(0, 8)}…${addr.slice(-6)}`;
}
