import { normalize } from "viem/ens";

import {
  NAME_PROTOCOLS,
  PROTOCOL_META,
  type NameProtocol,
} from "./constants.js";
import type { ParsedName } from "./types.js";

const TLD_TO_PROTOCOL: Record<string, NameProtocol> = {
  ".eth": "ens",
  ".gwei": "gns",
  ".wei": "wns",
};

export function parseNameProtocol(raw: string | undefined): NameProtocol {
  const v = (raw ?? "").trim().toLowerCase();
  if (!(NAME_PROTOCOLS as readonly string[]).includes(v)) {
    throw new Error(`--protocol must be one of: ${NAME_PROTOCOLS.join(", ")}`);
  }
  return v as NameProtocol;
}

/**
 * Parse a manage-command `--name` that must include a supported TLD.
 * Rejects subdomains (more than one label before the TLD).
 */
export function parseManagedName(raw: string): ParsedName {
  const trimmed = raw.trim();
  const lower = trimmed.toLowerCase();
  const tld = Object.keys(TLD_TO_PROTOCOL).find((t) => lower.endsWith(t));
  if (!tld) {
    throw new Error(
      `--name must end with .eth, .gwei, or .wei (got "${trimmed}")`
    );
  }
  const protocol = TLD_TO_PROTOCOL[tld]!;
  const withoutTld = trimmed.slice(0, -tld.length);
  if (!withoutTld || withoutTld.includes(".")) {
    throw new Error(
      `Only top-level names are supported (e.g. alice${tld}), not subdomains.`
    );
  }
  return normalizeParsed(withoutTld, protocol);
}

/**
 * Parse a register `--name` which may be a bare label or a full name.
 * When a TLD is present it must match `--protocol`.
 */
export function parseRegisterName(raw: string, protocol: NameProtocol): ParsedName {
  const trimmed = raw.trim();
  const lower = trimmed.toLowerCase();
  const tld = Object.keys(TLD_TO_PROTOCOL).find((t) => lower.endsWith(t));
  if (tld) {
    const detected = TLD_TO_PROTOCOL[tld]!;
    if (detected !== protocol) {
      throw new Error(
        `--name "${trimmed}" is a ${detected.toUpperCase()} name but --protocol is ${protocol}`
      );
    }
    const withoutTld = trimmed.slice(0, -tld.length);
    if (!withoutTld || withoutTld.includes(".")) {
      throw new Error(
        `Only top-level names are supported (e.g. alice${tld}), not subdomains.`
      );
    }
    return normalizeParsed(withoutTld, protocol);
  }
  if (trimmed.includes(".")) {
    throw new Error(
      `--name "${trimmed}" has an unsupported TLD. Use .eth, .gwei, .wei, or a bare label with --protocol.`
    );
  }
  return normalizeParsed(trimmed, protocol);
}

function normalizeParsed(labelRaw: string, protocol: NameProtocol): ParsedName {
  const tld = PROTOCOL_META[protocol].tld;
  let label: string;
  if (protocol === "ens") {
    try {
      label = normalize(labelRaw);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`Invalid ENS label "${labelRaw}": ${msg}`);
    }
  } else {
    // GNS/WNS on-chain normalize lowercases ASCII; reject dots already handled.
    label = labelRaw.toLowerCase();
  }
  if (!label) {
    throw new Error("Name label must not be empty.");
  }
  if (label.includes(".")) {
    throw new Error("Name label must not contain dots.");
  }
  return { label, protocol, name: `${label}${tld}` };
}
