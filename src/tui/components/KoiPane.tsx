import React from "react";
import { Box, Text } from "ink";

import { useFocus } from "../context/FocusContext.js";
import { useSessionUi } from "../context/SessionUiContext.js";
import { useTerminalSize } from "../context/TerminalSizeContext.js";
import { KOI_ART_WIDTH, koiPaneInnerWidth, koiPaneWidth } from "../layout-constants.js";
import { centeredLine } from "../text-layout.js";
import KohakuKoi from "../widgets/KohakuKoi.js";
import { PaneFrame } from "./PaneFrame.js";
import { SelectList } from "./SelectList.js";

type KoiPaneProps = {
  koiSize?: "tiny" | "compact" | "medium";
};

export function KoiPane({ koiSize = "tiny" }: KoiPaneProps) {
  const { focusKoi } = useFocus();
  const sessionUi = useSessionUi();
  const { columns } = useTerminalSize();
  const width = koiPaneWidth(columns);
  const innerWidth = koiPaneInnerWidth(columns);

  const items = [
    { label: "Switch wallet", value: "switch-wallet" as const },
    { label: "Quit", value: "quit" as const },
  ];

  return (
    <PaneFrame focused={focusKoi} width={width}>
      {sessionUi ? (
        <Box flexShrink={0} width={innerWidth} flexDirection="column" marginBottom={1}>
          <Text bold wrap="truncate-end">{centeredLine("Kohaku CLI", innerWidth)}</Text>
          <Text dimColor wrap="truncate-end">
            {centeredLine(`Network: ${sessionUi.networkLabel}`, innerWidth)}
          </Text>
        </Box>
      ) : null}
      <Box flexDirection="column" alignItems="center" flexShrink={0} width={KOI_ART_WIDTH}>
        <KohakuKoi size={koiSize} />
      </Box>
      {sessionUi ? (
        <Box marginTop={1} flexShrink={0}>
          <SelectList
            items={items}
            active={focusKoi}
            columnWidth={innerWidth}
            reservedRows={14}
            onSelect={(v) => {
              if (v === "switch-wallet") sessionUi.onSwitchWallet();
              else sessionUi.onQuit();
            }}
          />
        </Box>
      ) : null}
    </PaneFrame>
  );
}
