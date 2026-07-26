import React, { useMemo, useState } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";

import {
  formatTrafficEntryLine,
  type NetworkTrafficEntry,
} from "../utils/network-traffic-log.js";

function summarize(entries: NetworkTrafficEntry[]): {
  total: number;
  tor: number;
  clearnet: number;
  byCategory: Record<string, number>;
} {
  const byCategory: Record<string, number> = {};
  let tor = 0;
  let clearnet = 0;
  for (const e of entries) {
    if (e.via === "tor") tor++;
    else clearnet++;
    byCategory[e.category] = (byCategory[e.category] ?? 0) + 1;
  }
  return { total: entries.length, tor, clearnet, byCategory };
}

export function NetworkTrafficViewer({
  walletName,
  logPath,
  entries,
}: {
  walletName: string;
  logPath: string;
  entries: NetworkTrafficEntry[];
}) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const rows = stdout.rows && stdout.rows > 0 ? stdout.rows : 24;
  const summary = useMemo(() => summarize(entries), [entries]);
  const lines = useMemo(
    () => entries.map((e) => formatTrafficEntryLine(e)),
    [entries]
  );

  const headerLines = 5;
  const footerLines = 2;
  const viewport = Math.max(4, rows - headerLines - footerLines);
  const maxOffset = Math.max(0, lines.length - viewport);
  const [offset, setOffset] = useState(maxOffset);

  useInput((input, key) => {
    if (input === "q" || key.escape) {
      exit();
      return;
    }
    if (lines.length <= viewport) return;
    if (input === "k" || key.upArrow) {
      setOffset((o) => Math.max(0, o - 1));
    }
    if (input === "j" || key.downArrow) {
      setOffset((o) => Math.min(maxOffset, o + 1));
    }
    if (key.pageUp || input === "K") {
      setOffset((o) => Math.max(0, o - viewport));
    }
    if (key.pageDown || input === "J" || input === " ") {
      setOffset((o) => Math.min(maxOffset, o + viewport));
    }
    if (input === "g") setOffset(0);
    if (input === "G") setOffset(maxOffset);
  });

  const visible = lines.slice(offset, offset + viewport);
  const end = Math.min(offset + viewport, lines.length);
  const cats = Object.entries(summary.byCategory)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${k}:${n}`)
    .join(" ");

  return (
    <Box flexDirection="column" height={rows}>
      <Text bold>Network traffic · {walletName}</Text>
      <Text dimColor wrap="truncate-end">
        {logPath}
      </Text>
      <Text wrap="truncate-end">
        {summary.total} events ·{" "}
        <Text color="green">{summary.tor} tor</Text>
        {" · "}
        <Text color="yellow">{summary.clearnet} clearnet</Text>
        {cats ? ` · ${cats}` : ""}
      </Text>
      <Text dimColor>
        ────────────────────────────────────────────────────────────────
      </Text>
      <Box flexDirection="column" flexGrow={1}>
        {entries.length === 0 ? (
          <Text dimColor>
            No traffic logged yet. Run balances / shield / unshield / transfer
            with this wallet first.
          </Text>
        ) : (
          visible.map((line, i) => {
            const entry = entries[offset + i]!;
            const color =
              entry.via === "tor"
                ? "green"
                : entry.ok === false || entry.error
                  ? "red"
                  : "yellow";
            return (
              <Text key={`${offset + i}`} color={color} wrap="truncate-end">
                {line}
              </Text>
            );
          })
        )}
      </Box>
      <Text dimColor wrap="truncate-end">
        j/k ↑↓ scroll · space/PgDn · g/G top/bottom · q quit
        {lines.length > 0
          ? ` · lines ${offset + 1}–${end} of ${lines.length}`
          : ""}
      </Text>
    </Box>
  );
}

export function summarizeNetworkTraffic(entries: NetworkTrafficEntry[]) {
  return summarize(entries);
}
