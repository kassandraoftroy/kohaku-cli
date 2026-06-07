import React, { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";

import { useFocus } from "../context/FocusContext.js";
import { useTerminalSize } from "../context/TerminalSizeContext.js";

export type ScrollLine = {
  text: string;
  color?: string;
  dim?: boolean;
  bold?: boolean;
};

type ScrollableLinesProps = {
  lines: ScrollLine[];
  /** Rows reserved outside this pane (header, footer, menu, etc.). */
  reservedRows?: number;
  active?: boolean;
};

export function ScrollableLines({
  lines,
  reservedRows = 8,
  active,
}: ScrollableLinesProps) {
  const { focusMain } = useFocus();
  const isActive = active ?? focusMain;
  const { rows: termRows } = useTerminalSize();
  const viewport = Math.max(4, termRows - reservedRows);
  const maxOffset = Math.max(0, lines.length - viewport);
  const [offset, setOffset] = useState(0);

  useEffect(() => {
    setOffset(0);
  }, [lines]);

  useEffect(() => {
    setOffset((o) => Math.min(o, maxOffset));
  }, [maxOffset]);

  useInput(
    (input, key) => {
      if (!isActive || lines.length <= viewport) return;

      if (input === "k") {
        setOffset((o) => Math.max(0, o - 1));
      }
      if (input === "j") {
        setOffset((o) => Math.min(maxOffset, o + 1));
      }
      if (key.pageUp || input === "K") {
        setOffset((o) => Math.max(0, o - viewport));
      }
      if (key.pageDown || input === "J") {
        setOffset((o) => Math.min(maxOffset, o + viewport));
      }
    },
    { isActive }
  );

  const visible = lines.slice(offset, offset + viewport);
  const canScroll = lines.length > viewport;
  const end = Math.min(offset + viewport, lines.length);

  return (
    <Box flexDirection="column" flexGrow={1} minHeight={Math.min(viewport, lines.length + (canScroll ? 1 : 0))}>
      {visible.map((line, i) => (
        <Text
          key={`${offset + i}-${line.text.slice(0, 24)}`}
          color={line.dim ? undefined : line.color}
          dimColor={line.dim}
          bold={line.bold}
          wrap="truncate-end"
        >
          {line.text}
        </Text>
      ))}
      {canScroll ? (
        <Text dimColor wrap="truncate-end">
          j/k or PgUp/PgDn scroll · lines {offset + 1}–{end} of {lines.length}
        </Text>
      ) : null}
    </Box>
  );
}
