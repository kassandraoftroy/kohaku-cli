import type { BalancesSnapshot, PrivateBalancesSnapshot } from "../lib/balances-snapshot.js";
import type { ScrollLine } from "./components/ScrollableLines.js";

function shortenAddr(addr: string): string {
  if (addr.length < 14) return addr;
  return `${addr.slice(0, 8)}…${addr.slice(-6)}`;
}

function shortenMiddle(text: string, max = 36): string {
  if (text.length <= max) return text;
  const head = Math.floor((max - 1) / 2);
  const tail = max - 1 - head;
  return `${text.slice(0, head)}…${text.slice(-tail)}`;
}

function section(title: string): ScrollLine {
  return { text: title, color: "#c92a2a", bold: true };
}

function row(symbol: string, amount: string): ScrollLine {
  return { text: `  ${symbol.padEnd(10)} ${amount}`, color: "#f5efe0" };
}

function noneLine(): ScrollLine {
  return { text: "  (none)", dim: true };
}

function privateSection(title: string, rows: { symbol: string; formatted_token_holdings: string }[]): ScrollLine[] {
  const lines: ScrollLine[] = [section(title)];
  if (rows.length === 0) {
    lines.push(noneLine());
  } else {
    for (const r of rows) {
      lines.push(row(r.symbol, r.formatted_token_holdings));
    }
  }
  return lines;
}

export function formatPrivateBalanceLines(
  snap: PrivateBalancesSnapshot,
  warnings: string[] = []
): ScrollLine[] {
  const lines: ScrollLine[] = [];
  for (const w of warnings) {
    lines.push({ text: `⚠ ${w}`, color: "#ffb000" });
  }
  lines.push(...privateSection("Private — Railgun", snap.privateRailgun));
  lines.push(...privateSection("Private — Privacy pools", snap.privatePrivacyPools));
  return lines;
}

export function formatBalancesLines(
  snap: BalancesSnapshot,
  verbose: boolean,
  warnings: string[]
): ScrollLine[] {
  const lines: ScrollLine[] = [];

  for (const w of warnings) {
    lines.push({ text: `⚠ ${w}`, color: "#ffb000" });
  }

  lines.push(section("Public (aggregated)"));
  if (snap.publicAggregated.length === 0) {
    lines.push(noneLine());
  } else {
    for (const r of snap.publicAggregated) {
      lines.push(row(r.symbol, r.formatted_token_holdings));
    }
  }

  lines.push(section("Private — Railgun"));
  if (snap.privateRailgun.length === 0) {
    lines.push(noneLine());
  } else {
    for (const r of snap.privateRailgun) {
      lines.push(row(r.symbol, r.formatted_token_holdings));
    }
  }

  lines.push(section("Private — Privacy pools"));
  if (snap.privatePrivacyPools.length === 0) {
    lines.push(noneLine());
  } else {
    for (const r of snap.privatePrivacyPools) {
      lines.push(row(r.symbol, r.formatted_token_holdings));
    }
  }

  if (verbose) {
    lines.push(section("Public by address"));
    const addrs = Object.keys(snap.publicByAddress);
    if (addrs.length === 0) {
      lines.push(noneLine());
    } else {
      for (const [i, addr] of addrs.entries()) {
        const idx = snap.publicAccountIndexByAddress[addr];
        lines.push({
          text: `  ${idx !== undefined ? `[${idx}] ` : ""}${addr}`,
          color: "#f5efe0",
        });
        const rows = snap.publicByAddress[addr] ?? [];
        if (rows.length === 0) {
          lines.push(noneLine());
        } else {
          for (const r of rows) {
            lines.push(row(r.symbol, r.formatted_token_holdings));
          }
        }
        if (i < addrs.length - 1) {
          lines.push({ text: "", dim: true });
        }
      }
    }

    if (snap.privacyPoolsNotes && snap.privacyPoolsNotes.length > 0) {
      lines.push(section("Privacy pool notes"));
      for (const n of snap.privacyPoolsNotes) {
        lines.push({
          text: `  label: ${shortenMiddle(n.label, 44)}`,
          dim: true,
        });
        lines.push({
          text: `  amount: ${n.balance_formatted} · asset: ${shortenAddr(n.asset_address)}`,
          dim: true,
        });
        lines.push({
          text: `  status: ${n.approved ? "approved" : "pending"} · precommit: ${shortenMiddle(n.precommitment, 30)}`,
          dim: true,
        });
      }
    }
  }

  return lines;
}
