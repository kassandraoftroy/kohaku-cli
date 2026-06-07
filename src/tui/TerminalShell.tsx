import React, { useEffect } from "react";
import { Box, useStdout } from "ink";

import {
  TerminalSizeProvider,
  useTerminalSize,
} from "./context/TerminalSizeContext.js";

const ALT_ON = "\x1b[?1049h\x1b[2J\x1b[H";
const ALT_OFF = "\x1b[?1049l";
/** Reset attributes and show cursor after Ink / TUI. */
const TERM_RESET = "\x1b[0m\x1b[?25h";

export function enterTuiTerminal(): void {
  if (!process.stdout.isTTY) return;
  process.stdout.write(ALT_ON);
}

export function leaveTuiTerminal(): void {
  if (!process.stdout.isTTY) return;
  process.stdout.write(`${TERM_RESET}${ALT_OFF}`);
}

function TerminalShellFrame({ children }: { children: React.ReactNode }) {
  const { stdout } = useStdout();
  const { rows, columns } = useTerminalSize();

  useEffect(() => {
    const id = setImmediate(() => {
      if (stdout.isTTY) stdout.emit("resize");
    });
    return () => clearImmediate(id);
  }, [stdout]);

  return (
    <Box width={columns} height={rows} flexDirection="column" overflow="hidden">
      {children}
    </Box>
  );
}

/** Full-screen wrapper: clips to terminal size and reflows on resize. */
export default function TerminalShell({ children }: { children: React.ReactNode }) {
  return (
    <TerminalSizeProvider>
      <TerminalShellFrame>{children}</TerminalShellFrame>
    </TerminalSizeProvider>
  );
}
