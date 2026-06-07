import React from "react";
import { Box } from "ink";

const HIGHLIGHT = "#c92a2a";
/** Invisible border when pane is unfocused (keeps layout stable vs toggling border on/off). */
const UNFOCUSED_BORDER = "#000000";

export function PaneFrame({
  focused,
  width,
  children,
}: {
  focused: boolean;
  width: number;
  children: React.ReactNode;
}) {
  return (
    <Box
      width={width}
      flexShrink={0}
      flexDirection="column"
      flexGrow={1}
      minHeight={0}
      borderStyle="round"
      borderColor={focused ? HIGHLIGHT : UNFOCUSED_BORDER}
      paddingX={1}
    >
      {children}
    </Box>
  );
}
