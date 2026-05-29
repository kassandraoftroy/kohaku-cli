import React from "react";
import { Box, Text } from "ink";
import KohakuKoi from "./KohakuKoi.js";
import AnimatedKoi from "./AnimatedKoi.js";

const NAVY = "#0f2a3f";
const CREAM = "#f5efe0";

type PageLayoutProps = {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  koiSize?: "tiny" | "compact" | "medium";
  /** Eye-flash on arrows; off on dense screens (e.g. main menu) for cleaner redraws. */
  animateKoi?: boolean;
  showKoi?: boolean;
  showFooter?: boolean;
};

export default function PageLayout({
  title,
  subtitle,
  children,
  koiSize = "tiny",
  animateKoi = true,
  showKoi = true,
  showFooter = true,
}: PageLayoutProps) {
  const Koi = animateKoi ? AnimatedKoi : KohakuKoi;

  return (
    <Box flexDirection="column" flexGrow={1} width="100%">
      <Box marginBottom={1}>
        <Text bold color={CREAM} backgroundColor={NAVY}>
          {` ${title} `}
        </Text>
        {subtitle ? <Text dimColor>{` ${subtitle}`}</Text> : null}
      </Box>

      <Box flexDirection="row" flexGrow={1} alignItems="flex-start" width="100%">
        {showKoi ? (
          <Box marginRight={1} flexShrink={0}>
            <Koi size={koiSize} />
          </Box>
        ) : null}
        <Box flexDirection="column" flexGrow={1} minWidth={0}>
          {children}
        </Box>
      </Box>

      {showFooter ? (
        <Box marginTop={1} flexShrink={0}>
          <Text dimColor>↑↓ move · Enter select · Esc back · q quit</Text>
        </Box>
      ) : null}
    </Box>
  );
}
