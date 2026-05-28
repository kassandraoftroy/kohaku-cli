/**
 * Kohaku koi logo as half-block terminal cells (▀/▄/█).
 * Cell grid from leanCLI kohaku.cells.json.
 */
import React from "react";
import { Box, Text } from "ink";
import cellsData from "./kohaku.cells.json";

type Cell = { ch: string; fg: string | null; bg: string | null };
type Grid = { width: number; height: number; rows: Cell[][] };
type Size = "medium" | "compact" | "tiny";

const GRIDS = cellsData as Record<Size, Grid>;

export interface KohakuKoiProps {
  size?: Size;
  mono?: boolean;
  navy?: string;
  red?: string;
  cream?: string;
  eyeColor?: string;
}

const EYE_POS: Partial<Record<Size, ReadonlyArray<readonly [number, number]>>> = {
  tiny: [[5, 5] as const],
  compact: [[7, 8] as const],
  medium: [[11, 12] as const],
};

const BRAND = {
  "#0f2a3f": "navy",
  "#c92a2a": "red",
  "#f5efe0": "cream",
} as const;

function recolor(
  hex: string | null,
  overrides: { navy?: string; red?: string; cream?: string }
): string | undefined {
  if (!hex) return undefined;
  const lower = hex.toLowerCase() as keyof typeof BRAND;
  const slot = BRAND[lower];
  if (slot && overrides[slot]) return overrides[slot];
  return hex;
}

function compactRow(row: Cell[]): { fg?: string; bg?: string; text: string }[] {
  const runs: { fg?: string; bg?: string; text: string }[] = [];
  let cur: { fg?: string; bg?: string; text: string } | null = null;
  for (const c of row) {
    const fg = c.fg ?? undefined;
    const bg = c.bg ?? undefined;
    if (cur && cur.fg === fg && cur.bg === bg) cur.text += c.ch;
    else {
      cur = { fg, bg, text: c.ch };
      runs.push(cur);
    }
  }
  return runs;
}

const KohakuKoi: React.FC<KohakuKoiProps> = ({
  size = "tiny",
  mono = false,
  navy,
  red,
  cream,
  eyeColor,
}) => {
  const grid = GRIDS[size];
  const overrides = { navy, red, cream };

  const eyePositions = eyeColor ? EYE_POS[size] : undefined;
  const renderRows: Cell[][] = eyePositions
    ? grid.rows.map((row, y) =>
        row.map((cell, x) =>
          eyePositions.some(([r, c]) => r === y && c === x)
            ? { ...cell, bg: eyeColor ?? cell.bg }
            : cell
        )
      )
    : grid.rows;

  if (mono) {
    const lines: string[] = renderRows.map((row) =>
      row
        .map((c) => {
          if (!c.fg && !c.bg) return " ";
          const color = (c.fg ?? c.bg)?.toLowerCase();
          if (color === "#0f2a3f") return "#";
          if (color === "#c92a2a") return "*";
          return ".";
        })
        .join("")
    );
    return (
      <Box flexDirection="column">
        {lines.map((l, i) => (
          <Text key={i}>{l}</Text>
        ))}
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      {renderRows.map((row, y) => (
        <Text key={y}>
          {compactRow(row).map((run, i) => (
            <Text
              key={i}
              color={recolor(run.fg ?? null, overrides)}
              backgroundColor={recolor(run.bg ?? null, overrides)}
            >
              {run.text}
            </Text>
          ))}
        </Text>
      ))}
    </Box>
  );
};

export default KohakuKoi;
