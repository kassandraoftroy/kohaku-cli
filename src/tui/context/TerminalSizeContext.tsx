import React, { createContext, useContext, useEffect, useState } from "react";
import { useStdout } from "ink";

export type TerminalSize = {
  rows: number;
  columns: number;
};

const DEFAULT_SIZE: TerminalSize = { rows: 24, columns: 80 };

const TerminalSizeContext = createContext<TerminalSize>(DEFAULT_SIZE);

function readTerminalSize(stdout: NodeJS.WriteStream): TerminalSize {
  return {
    rows: stdout.rows && stdout.rows > 0 ? stdout.rows : DEFAULT_SIZE.rows,
    columns:
      stdout.columns && stdout.columns > 0 ? stdout.columns : DEFAULT_SIZE.columns,
  };
}

/** Subscribes to stdout `resize` and re-renders the tree when the terminal changes size. */
export function TerminalSizeProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const { stdout } = useStdout();
  const [size, setSize] = useState(() => readTerminalSize(stdout));

  useEffect(() => {
    const onResize = () => setSize(readTerminalSize(stdout));
    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout]);

  return (
    <TerminalSizeContext.Provider value={size}>
      {children}
    </TerminalSizeContext.Provider>
  );
}

export function useTerminalSize(): TerminalSize {
  return useContext(TerminalSizeContext);
}
