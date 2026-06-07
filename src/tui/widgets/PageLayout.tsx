import React from "react";
import { Box, Text } from "ink";
import KohakuKoi from "./KohakuKoi.js";
import AnimatedKoi from "./AnimatedKoi.js";
import { KoiPane } from "../components/KoiPane.js";
import { MainPaneHeader } from "../components/MainPaneHeader.js";
import { PersistentBalancesPanel } from "../components/PersistentBalancesPanel.js";
import { PaneFrame } from "../components/PaneFrame.js";
import { useBalances } from "../context/BalancesContext.js";
import { useFocus } from "../context/FocusContext.js";
import { useTerminalSize } from "../context/TerminalSizeContext.js";
import { contentPaneInnerWidth, contentPaneWidth } from "../layout-constants.js";

const NAVY = "#0f2a3f";
const CREAM = "#f5efe0";

type PageLayoutProps = {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  koiSize?: "tiny" | "compact" | "medium";
  animateKoi?: boolean;
  showKoi?: boolean;
  showFooter?: boolean;
  footerHint?: string;
};

export default function PageLayout({
  title,
  subtitle,
  children,
  koiSize = "tiny",
  animateKoi = true,
  showKoi = true,
  showFooter = true,
  footerHint,
}: PageLayoutProps) {
  const Koi = animateKoi ? AnimatedKoi : KohakuKoi;
  const balances = useBalances();
  const { focusMain } = useFocus();
  const { columns } = useTerminalSize();
  const sessionMode = balances !== null;
  const mainWidth = contentPaneWidth(columns);
  const mainInner = contentPaneInnerWidth(columns);

  const defaultFooter = sessionMode
    ? "←→ switch pane · ↑↓ move · Enter select · Esc menu · q quit"
    : "↑↓ move · Enter select · Esc menu · q quit";

  return (
    <Box flexDirection="column" flexGrow={1} width="100%">
      <Box marginBottom={1} flexShrink={0}>
        <Text bold color={CREAM} backgroundColor={NAVY}>
          {` ${title} `}
        </Text>
        {subtitle ? <Text dimColor>{` ${subtitle}`}</Text> : null}
      </Box>

      <Box flexDirection="row" flexGrow={1} alignItems="stretch" width="100%" minHeight={0}>
        {sessionMode && showKoi ? (
          <KoiPane koiSize={koiSize} />
        ) : showKoi ? (
          <Box marginRight={1} flexShrink={0}>
            <Koi size={koiSize} />
          </Box>
        ) : null}
        {sessionMode ? (
          <PaneFrame focused={focusMain} width={mainWidth}>
            <MainPaneHeader innerWidth={mainInner} />
            {children}
          </PaneFrame>
        ) : (
          <Box flexDirection="column" flexGrow={1} minWidth={0}>
            {children}
          </Box>
        )}
        {sessionMode ? (
          <PersistentBalancesPanel />
        ) : null}
      </Box>

      {showFooter ? (
        <Box marginTop={1} flexShrink={0}>
          <Text dimColor>{footerHint ?? defaultFooter}</Text>
        </Box>
      ) : null}
    </Box>
  );
}
