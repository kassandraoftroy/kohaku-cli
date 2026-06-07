import React, { useMemo } from "react";
import { Box, Text } from "ink";

import { formatBalancesLines } from "../balances-format.js";
import { useBalances } from "../context/BalancesContext.js";
import { useFocus } from "../context/FocusContext.js";
import { useTerminalSize } from "../context/TerminalSizeContext.js";
import {
  contentPaneInnerWidth,
  contentPaneWidth,
} from "../layout-constants.js";
import { centeredLine } from "../text-layout.js";
import { PaneFrame } from "./PaneFrame.js";
import { ScrollableLines } from "./ScrollableLines.js";
import { SelectList } from "./SelectList.js";

const CREAM = "#f5efe0";

export function PersistentBalancesPanel() {
  const balances = useBalances();
  const { focusBalances } = useFocus();
  const { columns: termCols } = useTerminalSize();
  const paneWidth = contentPaneWidth(termCols);
  const innerWidth = contentPaneInnerWidth(termCols);
  // Keep actions clearly separated and visible at the bottom.
  const scrollReservedRows = 12;

  const lines = useMemo(() => {
    if (!balances?.snap) return [];
    return formatBalancesLines(balances.snap, balances.verbose, balances.warnings);
  }, [balances?.snap, balances?.verbose, balances?.warnings]);

  const actionItems = balances
    ? [
        { label: "Refresh", value: "refresh" as const },
        {
          label: balances.verbose ? "See concise" : "See verbose",
          value: "toggle" as const,
        },
      ]
    : [{ label: "Refresh", value: "refresh" as const }];

  if (!balances) {
    return (
      <PaneFrame focused={false} width={paneWidth}>
        <Text bold color={CREAM}>
          {centeredLine("Wallet: —", innerWidth)}
        </Text>
        <Text dimColor>Unlock a wallet to view balances.</Text>
      </PaneFrame>
    );
  }

  const walletHeader = centeredLine(`Wallet: ${balances.walletName}`, innerWidth);

  return (
    <PaneFrame focused={focusBalances} width={paneWidth}>
      <Box flexShrink={0} width={innerWidth}>
        <Text bold color={CREAM} wrap="truncate-end">
          {walletHeader}
        </Text>
      </Box>
      <Box flexShrink={0} width={innerWidth}>
        <Text bold color={CREAM} wrap="truncate-end">
          {centeredLine("Balances", innerWidth)}
        </Text>
      </Box>
      <Text dimColor>{balances.verbose ? "verbose" : "concise"}</Text>

      {balances.phase === "loading" ? (
        <Text color={CREAM}>Working… fetching balances</Text>
      ) : null}

      {balances.phase === "error" ? (
        <Text color="#c92a2a">{balances.error ?? "Failed to load balances"}</Text>
      ) : null}

      {balances.phase === "view" && balances.snap ? (
        <Box flexGrow={1} minHeight={0} flexDirection="column">
          <ScrollableLines
            lines={lines}
            active={focusBalances}
            reservedRows={scrollReservedRows}
          />
        </Box>
      ) : null}

      <Box marginTop={2} flexShrink={0}>
        <SelectList
          items={actionItems}
          active={focusBalances}
          columnWidth={innerWidth}
          reservedRows={14}
          onSelect={(v) => {
            if (v === "refresh") balances.refresh();
            else balances.toggleVerbose();
          }}
        />
      </Box>
    </PaneFrame>
  );
}
