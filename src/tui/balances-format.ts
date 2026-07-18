import type { BalancesSnapshot, PrivateBalancesSnapshot } from "../lib/balances-snapshot.js";
import type { PrivateNoteRow } from "../lib/private-notes.js";
import type { SupportedProtocol } from "../utils/plugins.js";
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

function row(symbol: string, amount: string, usdValue: string, status?: string): ScrollLine {
  const statusSuffix = status ? formatStatusSuffix(status, symbol) : "";
  const usd =
    usdValue === "--" ? "  --" : `  $${usdValue}`;
  return {
    text: `  ${symbol.padEnd(10)} ${amount}${usd}${statusSuffix}`,
    color: "#f5efe0",
  };
}

function formatStatusSuffix(status: string, symbol: string): string {
  if (status === "pending" && symbol.includes("(pending)")) {
    return "";
  }
  return status === "pending" ? `  (${status})` : `  · ${status}`;
}

function noneLine(): ScrollLine {
  return { text: "  (none)", dim: true };
}

function privateSection(
  title: string,
  rows: {
    symbol: string;
    formatted_token_holdings: string;
    usd_value: string;
    status?: string;
  }[]
): ScrollLine[] {
  const lines: ScrollLine[] = [section(title)];
  if (rows.length === 0) {
    lines.push(noneLine());
  } else {
    for (const r of rows) {
      lines.push(row(r.symbol, r.formatted_token_holdings, r.usd_value, r.status));
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
  lines.push(...privateSection("Private — Tornado", snap.privateTornado));
  return lines;
}

function formatNoteDetailLines(note: PrivateNoteRow): ScrollLine[] {
  const lines: ScrollLine[] = [
    {
      text: `  amount: ${note.balance_formatted} · asset: ${shortenAddr(note.asset_address)}`,
      dim: true,
    },
  ];

  if (note.protocol === "privacy-pools") {
    if (note.label) {
      lines.unshift({
        text: `  label: ${shortenMiddle(note.label, 44)}`,
        dim: true,
      });
    }
    lines.push({
      text: `  status: ${note.approved ? "approved" : "pending"}${note.precommitment ? ` · precommit: ${shortenMiddle(note.precommitment, 30)}` : ""}`,
      dim: true,
    });
    return lines;
  }

  if (note.protocol === "tornado") {
    if (note.deposit_index) {
      lines.unshift({ text: `  deposit #${note.deposit_index}`, dim: true });
    }
    const extras = [
      note.leaf_index ? `leaf ${note.leaf_index}` : null,
      note.pool ? `pool ${shortenAddr(note.pool)}` : null,
      note.status,
    ].filter(Boolean);
    if (extras.length > 0) {
      lines.push({ text: `  ${extras.join(" · ")}`, dim: true });
    }
    return lines;
  }

  if (note.railgun_address) {
    lines.unshift({
      text: `  address: ${shortenMiddle(note.railgun_address, 44)}`,
      dim: true,
    });
  }
  const extras = [
    note.tree_number != null ? `tree ${note.tree_number}` : null,
    note.leaf_index != null ? `leaf ${note.leaf_index}` : null,
    note.status,
  ].filter(Boolean);
  if (note.blinded_commitment) {
    extras.push(`commit ${shortenMiddle(note.blinded_commitment, 24)}`);
  }
  if (note.memo) {
    extras.push(`memo ${shortenMiddle(note.memo, 20)}`);
  }
  if (extras.length > 0) {
    lines.push({ text: `  ${extras.join(" · ")}`, dim: true });
  }
  return lines;
}

function privateNotesSection(
  title: string,
  notes: PrivateNoteRow[] | undefined
): ScrollLine[] {
  const lines: ScrollLine[] = [section(title)];
  if (!notes || notes.length === 0) {
    lines.push(noneLine());
    return lines;
  }
  for (const n of notes) {
    lines.push(...formatNoteDetailLines(n));
  }
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
      lines.push(row(r.symbol, r.formatted_token_holdings, r.usd_value));
    }
  }

  lines.push(section("Private — Railgun"));
  if (snap.privateRailgun.length === 0) {
    lines.push(noneLine());
  } else {
    for (const r of snap.privateRailgun) {
      lines.push(row(r.symbol, r.formatted_token_holdings, r.usd_value, r.status));
    }
  }

  lines.push(section("Private — Privacy pools"));
  if (snap.privatePrivacyPools.length === 0) {
    lines.push(noneLine());
  } else {
    for (const r of snap.privatePrivacyPools) {
      lines.push(
        row(r.symbol, r.formatted_token_holdings, r.usd_value, r.status)
      );
    }
  }

  lines.push(section("Private — Tornado"));
  if (snap.privateTornado.length === 0) {
    lines.push(noneLine());
  } else {
    for (const r of snap.privateTornado) {
      lines.push(row(r.symbol, r.formatted_token_holdings, r.usd_value, r.status));
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
            lines.push(row(r.symbol, r.formatted_token_holdings, r.usd_value));
          }
        }
        if (i < addrs.length - 1) {
          lines.push({ text: "", dim: true });
        }
      }
    }

    if (snap.privateNotes) {
      const noteSections: Array<{ title: string; protocol: SupportedProtocol }> = [
        { title: "Railgun notes", protocol: "railgun" },
        { title: "Privacy pool notes", protocol: "privacy-pools" },
        { title: "Tornado notes", protocol: "tornado" },
      ];
      for (const { title, protocol } of noteSections) {
        if (snap.privateNotes[protocol] !== undefined) {
          lines.push(...privateNotesSection(title, snap.privateNotes[protocol]));
        }
      }
    }
  }

  return lines;
}
