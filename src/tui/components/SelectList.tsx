import React, { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";

import { useFocus } from "../context/FocusContext.js";
import { useBalances } from "../context/BalancesContext.js";
import { useTerminalSize } from "../context/TerminalSizeContext.js";
import { mainPaneWidth } from "../layout-constants.js";

const HIGHLIGHT = "#c92a2a";
const CREAM = "#f5efe0";

export type SelectItem<T> = {
  label: string;
  value: T;
  disabled?: boolean;
};

type SelectListProps<T> = {
  items: SelectItem<T>[];
  onSelect: (value: T) => void;
  onCancel?: () => void;
  initialIndex?: number;
  active?: boolean;
  columnWidth?: number;
  reservedRows?: number;
};

export function SelectList<T>({
  items,
  onSelect,
  onCancel,
  initialIndex = 0,
  active,
  columnWidth,
  reservedRows = 10,
}: SelectListProps<T>) {
  const balances = useBalances();
  const sessionMode = balances !== null;
  const { rows: termRows, columns: termCols } = useTerminalSize();
  const { focusMain } = useFocus();

  const [index, setIndex] = useState(() => {
    const firstEnabled = items.findIndex((i) => !i.disabled);
    if (firstEnabled >= 0) return firstEnabled;
    return initialIndex;
  });
  const [scrollTop, setScrollTop] = useState(0);

  const lineWidth = columnWidth ?? mainPaneWidth(termCols, sessionMode);
  const viewport = Math.max(4, termRows - reservedRows);

  const isActive = active ?? focusMain;

  useEffect(() => {
    setScrollTop((top) => {
      const maxTop = Math.max(0, items.length - viewport);
      let next = Math.min(top, maxTop);
      if (index < next) next = index;
      if (index >= next + viewport) next = Math.max(0, index - viewport + 1);
      return next;
    });
  }, [index, viewport, items.length]);

  useInput(
    (input, key) => {
      if (!isActive) return;
      if (key.escape) {
        onCancel?.();
        return;
      }
      if (key.return) {
        const item = items[index];
        if (item && !item.disabled) onSelect(item.value);
        return;
      }
      if (key.upArrow) {
        let next = index;
        for (let i = 0; i < items.length; i++) {
          next = (next - 1 + items.length) % items.length;
          if (!items[next]?.disabled) break;
        }
        setIndex(next);
      }
      if (key.downArrow) {
        let next = index;
        for (let i = 0; i < items.length; i++) {
          next = (next + 1) % items.length;
          if (!items[next]?.disabled) break;
        }
        setIndex(next);
      }
      if (input === "q" || input === "Q") {
        onCancel?.();
      }
    },
    { isActive }
  );

  const visible = items.slice(scrollTop, scrollTop + viewport);
  const canScroll = items.length > viewport;

  return (
    <Box flexDirection="column" width={lineWidth}>
      {visible.map((item, i) => {
        const itemIndex = scrollTop + i;
        const selected = itemIndex === index;
        const showMarker = isActive && selected;
        const prefix = showMarker ? "› " : "  ";
        return (
          <Box key={itemIndex} width={lineWidth}>
            <Text
              color={showMarker ? HIGHLIGHT : item.disabled ? undefined : CREAM}
              dimColor={item.disabled && !showMarker}
              wrap="truncate-end"
            >
              {prefix}
              {item.label}
            </Text>
          </Box>
        );
      })}
      {canScroll ? (
        <Text dimColor wrap="truncate-end">
          {scrollTop + 1}–{Math.min(scrollTop + viewport, items.length)} of{" "}
          {items.length} · ↑↓ scroll
        </Text>
      ) : null}
    </Box>
  );
}
