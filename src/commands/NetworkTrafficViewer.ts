import chalk from "chalk";
import * as readline from "node:readline";

import {
  formatTrafficEntryLine,
  isLocalEntry,
  type NetworkTrafficEntry,
} from "../utils/network-traffic-log.js";

export function summarizeNetworkTraffic(entries: NetworkTrafficEntry[]): {
  total: number;
  tor: number;
  local: number;
  clearnet: number;
  byCategory: Record<string, number>;
} {
  const byCategory: Record<string, number> = {};
  let tor = 0;
  let local = 0;
  let clearnet = 0;
  for (const e of entries) {
    if (e.via === "tor") tor++;
    else if (isLocalEntry(e)) local++;
    else clearnet++;
    byCategory[e.category] = (byCategory[e.category] ?? 0) + 1;
  }
  return { total: entries.length, tor, local, clearnet, byCategory };
}

function colorLine(entry: NetworkTrafficEntry, line: string): string {
  if (entry.via === "tor") return chalk.green(line);
  if (isLocalEntry(entry)) return chalk.greenBright(line);
  if (entry.ok === false || entry.error) return chalk.red(line);
  return chalk.yellow(line);
}

function printHeader(
  walletName: string,
  logPath: string,
  summary: ReturnType<typeof summarizeNetworkTraffic>,
  cols: number
): void {
  const cats = Object.entries(summary.byCategory)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${k}:${n}`)
    .join(" ");
  console.log(chalk.bold(`Network traffic · ${walletName}`));
  console.log(chalk.dim(logPath.slice(0, cols)));
  console.log(
    `${summary.total} events · ` +
      chalk.green(`${summary.tor} tor`) +
      ` · ` +
      chalk.greenBright(`${summary.local} local`) +
      ` · ` +
      chalk.yellow(`${summary.clearnet} clearnet`) +
      (cats ? ` · ${cats}` : "")
  );
  console.log(chalk.dim("─".repeat(Math.min(72, cols))));
}

/**
 * Interactive pager: renders a viewport of lines, handles j/k/g/G/q/space in
 * raw mode. Falls back to a plain dump if stdin is not a TTY.
 */
export async function runNetworkTrafficPager(
  walletName: string,
  logPath: string,
  entries: NetworkTrafficEntry[]
): Promise<void> {
  const summary = summarizeNetworkTraffic(entries);
  const lines = entries.map((e) => formatTrafficEntryLine(e));

  // Non-TTY or no entries: just dump and return.
  if (!process.stdout.isTTY || !process.stdin.isTTY || entries.length === 0) {
    const cols = process.stdout.columns ?? 120;
    printHeader(walletName, logPath, summary, cols);
    if (entries.length === 0) {
      console.log(
        chalk.dim(
          "No traffic logged yet. Run balances / shield / unshield / transfer with this wallet first."
        )
      );
    } else {
      for (let i = 0; i < entries.length; i++) {
        process.stdout.write(colorLine(entries[i]!, lines[i]!) + "\n");
      }
    }
    return;
  }

  const rows = process.stdout.rows ?? 24;
  const cols = process.stdout.columns ?? 120;
  const HEADER = 5; // bold title + path + summary + rule + one blank line of breathing room
  const FOOTER = 1; // help bar
  const viewport = Math.max(4, rows - HEADER - FOOTER);
  const maxOffset = Math.max(0, lines.length - viewport);
  let offset = maxOffset; // start at bottom (most recent)

  function render(): void {
    // Clear screen and move to top.
    process.stdout.write("\x1b[2J\x1b[H");
    printHeader(walletName, logPath, summary, cols);

    const visible = lines.slice(offset, offset + viewport);
    for (let i = 0; i < visible.length; i++) {
      const entry = entries[offset + i]!;
      const truncated = visible[i]!.slice(0, cols);
      process.stdout.write(colorLine(entry, truncated) + "\n");
    }
    // Pad remaining viewport rows so the footer stays pinned.
    for (let i = visible.length; i < viewport; i++) {
      process.stdout.write("\n");
    }

    const end = Math.min(offset + viewport, lines.length);
    const scrollInfo = lines.length > 0 ? ` · lines ${offset + 1}–${end} of ${lines.length}` : "";
    process.stdout.write(
      chalk.dim(`j/k ↑↓ scroll · space/PgDn · g/G top/bottom · q quit${scrollInfo}`)
    );
  }

  render();

  return new Promise((resolve) => {
    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);

    function onKey(_: string | undefined, key: readline.Key): void {
      if (!key) return;
      const name = key.name ?? "";

      if (key.ctrl && name === "c") {
        cleanup();
        process.exit(0);
      }

      if (name === "q" || name === "escape") {
        cleanup();
        return;
      }

      const prevOffset = offset;

      if (name === "k" || name === "up") {
        offset = Math.max(0, offset - 1);
      } else if (name === "j" || name === "down") {
        offset = Math.min(maxOffset, offset + 1);
      } else if (name === "pageup" || name === "K") {
        offset = Math.max(0, offset - viewport);
      } else if (name === "pagedown" || name === "J" || name === "space") {
        offset = Math.min(maxOffset, offset + viewport);
      } else if (name === "g") {
        offset = 0;
      } else if (name === "G") {
        offset = maxOffset;
      }

      if (offset !== prevOffset) render();
    }

    function cleanup(): void {
      process.stdin.setRawMode(false);
      process.stdin.off("keypress", onKey);
      // Move cursor to a fresh line after the pager.
      process.stdout.write("\x1b[2J\x1b[H");
      resolve();
    }

    process.stdin.on("keypress", onKey);
  });
}
