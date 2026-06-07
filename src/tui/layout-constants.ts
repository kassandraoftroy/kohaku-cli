import cellsData from "./widgets/kohaku.cells.json";

const TINY_KOI = cellsData.tiny as { width: number; height: number };

/** Pixel width of the tiny koi art (do not squeeze below this). */
export const KOI_ART_WIDTH = TINY_KOI.width;

const KOI_PANE_CHROME = 4;

/** Narrow koi column — at least wide enough for the art, else ~20% of terminal. */
export function koiPaneWidth(columns: number): number {
  const minForArt = KOI_ART_WIDTH + KOI_PANE_CHROME;
  const proportional = Math.floor(columns / 5);
  return Math.max(minForArt, proportional);
}

/** Main and balances panes split the remaining width equally. */
export function contentPaneWidth(columns: number): number {
  const koi = koiPaneWidth(columns);
  const remaining = Math.max(44, columns - koi);
  return Math.max(22, Math.floor(remaining / 2));
}

export function koiPaneInnerWidth(columns: number): number {
  return Math.max(10, koiPaneWidth(columns) - 4);
}

export function contentPaneInnerWidth(columns: number): number {
  return Math.max(16, contentPaneWidth(columns) - 4);
}

/** Main content column width in session layout. */
export function mainPaneWidth(columns: number, sessionMode: boolean): number {
  if (!sessionMode) return Math.max(24, columns - 4);
  return contentPaneInnerWidth(columns);
}

/** Scroll viewport row count for the balances list. */
export function balancesScrollViewport(termRows: number): number {
  return Math.min(14, Math.max(4, termRows - 18));
}
