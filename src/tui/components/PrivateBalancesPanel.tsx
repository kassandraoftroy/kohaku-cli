import React from "react";
import { Box, Text } from "ink";

import type { PrivateBalancesSnapshot } from "../../lib/balances-snapshot.js";
import { formatPrivateBalanceLines } from "../balances-format.js";

const CREAM = "#f5efe0";

export function PrivateBalancesPanel({
  loading,
  snapshot,
  warnings = [],
}: {
  loading: boolean;
  snapshot: PrivateBalancesSnapshot | null;
  warnings?: string[];
}) {
  if (loading) {
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text color={CREAM}>Working… loading private balances</Text>
      </Box>
    );
  }

  if (!snapshot) {
    return null;
  }

  const lines = formatPrivateBalanceLines(snapshot, warnings);

  return (
    <Box flexDirection="column" marginBottom={1}>
      {lines.map((line, i) => (
        <Text
          key={i}
          color={line.color}
          bold={line.bold}
          dimColor={line.dim}
        >
          {line.text}
        </Text>
      ))}
    </Box>
  );
}
