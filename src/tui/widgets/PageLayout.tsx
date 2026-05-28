import React from "react";
import { Box, Text } from "ink";
import AnimatedKoi from "./AnimatedKoi.js";

const NAVY = "#0f2a3f";
const CREAM = "#f5efe0";

type PageLayoutProps = {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  koiSize?: "tiny" | "compact" | "medium";
};

export default function PageLayout({
  title,
  subtitle,
  children,
  koiSize = "tiny",
}: PageLayoutProps) {
  return (
    <Box flexDirection="column" paddingX={1} paddingY={0}>
      <Box marginBottom={1}>
        <Text bold color={CREAM} backgroundColor={NAVY}>
          {" "}
          {title}
          {" "}
        </Text>
        {subtitle ? (
          <Text dimColor>
            {" "}
            {subtitle}
          </Text>
        ) : null}
      </Box>
      <Box flexDirection="row">
        <Box marginRight={2} flexDirection="column">
          <AnimatedKoi size={koiSize} />
        </Box>
        <Box flexDirection="column" flexGrow={1}>
          {children}
        </Box>
      </Box>
      <Box marginTop={1}>
        <Text dimColor>↑↓ navigate · Enter select · Esc back · q quit</Text>
      </Box>
    </Box>
  );
}
