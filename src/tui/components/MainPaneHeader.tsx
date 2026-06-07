import React from "react";
import { Box, Text } from "ink";

import { useSessionUi } from "../context/SessionUiContext.js";
import { centeredLine } from "../text-layout.js";

const CREAM = "#f5efe0";

export function MainPaneHeader({ innerWidth }: { innerWidth: number }) {
  const sessionUi = useSessionUi();
  if (!sessionUi) return null;

  return (
    <Box flexDirection="column" flexShrink={0} marginBottom={1}>
      <Text bold color={CREAM} wrap="truncate-end">
        {centeredLine(`Wallet: ${sessionUi.walletName}`, innerWidth)}
      </Text>
      <Text bold color={CREAM} wrap="truncate-end">
        {centeredLine("Actions", innerWidth)}
      </Text>
    </Box>
  );
}
