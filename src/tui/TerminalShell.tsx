import React, { useEffect } from "react";
import { Box, useStdout } from "ink";

const ALT_ON = "\x1b[?1049h\x1b[2J\x1b[H";
const ALT_OFF = "\x1b[?1049l";

export function enterTuiTerminal(): void {
  process.stdout.write(ALT_ON);
}

export function leaveTuiTerminal(): void {
  process.stdout.write(ALT_OFF);
}

/** Full-screen wrapper: clips to terminal size so Ink can erase frames cleanly. */
export default function TerminalShell({ children }: { children: React.ReactNode }) {
  const { stdout } = useStdout();
  const rows = stdout.rows ?? 24;
  const columns = stdout.columns ?? 80;

  useEffect(() => {
    process.stdout.write("\x1b[2J\x1b[H");
  }, []);

  return (
    <Box width={columns} height={rows} flexDirection="column" overflow="hidden">
      {children}
    </Box>
  );
}
