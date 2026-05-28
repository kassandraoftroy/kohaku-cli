import React, { useState } from "react";
import { Box, Text, useInput } from "ink";

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
};

export function SelectList<T>({
  items,
  onSelect,
  onCancel,
  initialIndex = 0,
}: SelectListProps<T>) {
  const [index, setIndex] = useState(() => {
    const firstEnabled = items.findIndex((i) => !i.disabled);
    if (firstEnabled >= 0) return firstEnabled;
    return initialIndex;
  });

  useInput((input, key) => {
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
  });

  return (
    <Box flexDirection="column">
      {items.map((item, i) => {
        const selected = i === index;
        return (
          <Text key={i} color={selected ? HIGHLIGHT : undefined}>
            {selected ? "› " : "  "}
            <Text color={item.disabled ? undefined : selected ? CREAM : undefined} dimColor={item.disabled}>
              {item.label}
            </Text>
          </Text>
        );
      })}
    </Box>
  );
}
