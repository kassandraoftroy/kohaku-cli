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

function terminalSize(stdout: NodeJS.WriteStream): { rows: number; columns: number } {
  const rows = stdout.rows;
  const columns = stdout.columns;
  return {
    rows: rows && rows > 0 ? rows : 24,
    columns: columns && columns > 0 ? columns : 80,
  };
}

/** Full-screen wrapper: clips to terminal size so Ink can erase frames cleanly. */
export default function TerminalShell({ children }: { children: React.ReactNode }) {
  const { stdout } = useStdout();
  const { rows, columns } = terminalSize(stdout);

  // Ink may not paint until a resize; nudge once after mount (mouse move used to do this).
  useEffect(() => {
    const id = setImmediate(() => {
      if (stdout.isTTY) {
        stdout.emit("resize");
      }
    });
    return () => clearImmediate(id);
  }, [stdout]);

  return (
    <Box width={columns} height={rows} flexDirection="column" overflow="hidden">
      {children}
    </Box>
  );
}
