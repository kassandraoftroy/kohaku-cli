import React from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";

import { useFocus } from "../context/FocusContext.js";

type TextPromptProps = {
  label: string;
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onCancel?: () => void;
  mask?: string;
  placeholder?: string;
  active?: boolean;
};

/**
 * Controlled prompt: keyboard is handled here so Esc is never swallowed by
 * ink-text-input (which registers its own active useInput when focus=true).
 */
export function TextPrompt({
  label,
  value,
  onChange,
  onSubmit,
  onCancel,
  mask,
  placeholder,
  active,
}: TextPromptProps) {
  const { focusMain } = useFocus();
  const isActive = active ?? focusMain;

  useInput((input, key) => {
    if (!isActive) return;
    if (key.escape) {
      onCancel?.();
      return;
    }
    if (key.return) {
      onSubmit();
      return;
    }
    if (key.backspace || key.delete) {
      onChange(value.slice(0, -1));
      return;
    }
    if (
      key.leftArrow ||
      key.rightArrow ||
      key.upArrow ||
      key.downArrow ||
      key.tab ||
      (key.shift && key.tab) ||
      key.ctrl ||
      key.meta
    ) {
      return;
    }
    if (input) {
      onChange(value + input);
    }
  }, { isActive });

  return (
    <Box flexDirection="column">
      <Text>{label}</Text>
      <Box>
        <Text color="#f5efe0">{"> "}</Text>
        <TextInput
          value={value}
          onChange={onChange}
          onSubmit={onSubmit}
          mask={mask}
          placeholder={placeholder}
          focus={false}
          showCursor={false}
        />
      </Box>
      <Text dimColor>
        {onCancel ? "Enter confirm · Esc menu" : "Enter confirm"}
      </Text>
    </Box>
  );
}
