import React from "react";
import { Box, Text } from "ink";
import TextInput from "ink-text-input";

type TextPromptProps = {
  label: string;
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onCancel?: () => void;
  mask?: string;
  placeholder?: string;
};

export function TextPrompt({
  label,
  value,
  onChange,
  onSubmit,
  onCancel,
  mask,
  placeholder,
}: TextPromptProps) {
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
        />
      </Box>
      <Text dimColor>Enter confirm · Esc cancel</Text>
    </Box>
  );
}
