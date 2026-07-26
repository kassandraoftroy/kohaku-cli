import { formatUnits, getAddress, isAddress } from "ethers";

import type { SupportedProtocol } from "../utils/plugins.js";
import { isPrivateBalanceNativeEth } from "../utils/tokens-util.js";

export type PrivateNoteRow = {
  protocol: SupportedProtocol;
  balance_raw: string;
  balance_formatted: string;
  asset_address: string;
  /** Known token symbol when address maps to ETH / defaults / loaded ERC-20 meta. */
  asset_symbol?: string;
  status?: string;
  /** Privacy pools note label (decimal string). */
  label?: string;
  precommitment?: string;
  approved?: boolean;
  /** Tornado / Railgun identifiers. */
  deposit_index?: string;
  leaf_index?: string;
  pool?: string;
  commitment?: string;
  tree_number?: string;
  blinded_commitment?: string;
  memo?: string;
  railgun_address?: string;
  /** Unix seconds (Tornado deposit event timestamp only). */
  deposit_timestamp?: string;
};

export function bigIntishToString(value: unknown): string {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number" && Number.isFinite(value)) {
    return BigInt(Math.trunc(value)).toString();
  }
  if (typeof value === "string" && value.trim()) {
    try {
      return BigInt(value).toString();
    } catch {
      return value;
    }
  }
  return "";
}

/** Format unix-seconds deposit timestamp for human tables (UTC ISO-8601, no ms). */
export function formatDepositTimestampIso(
  unixSeconds: string | undefined
): string {
  if (!unixSeconds?.trim()) return "---";
  try {
    const sec = BigInt(unixSeconds);
    const ms = Number(sec * 1000n);
    if (!Number.isFinite(ms)) return unixSeconds;
    return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
  } catch {
    return unixSeconds;
  }
}

/** Prefer known symbol; fall back to the asset address. */
export function formatNoteAssetLabel(n: PrivateNoteRow): string {
  return n.asset_symbol ?? n.asset_address;
}

export function addressishToHex(value: unknown): string {
  if (typeof value === "bigint") {
    return `0x${value.toString(16).padStart(40, "0")}`;
  }
  if (typeof value !== "string") {
    return "---";
  }
  const trimmed = value.trim();
  if (!trimmed) return "---";
  if (isAddress(trimmed)) {
    return getAddress(trimmed);
  }
  const raw: string = trimmed;
  if (raw.startsWith("0x") && raw.length === 42) {
    try {
      return getAddress(raw);
    } catch {
      return raw;
    }
  }
  try {
    return `0x${BigInt(raw).toString(16).padStart(40, "0")}`;
  } catch {
    return raw;
  }
}

function noteBalanceRaw(note: Record<string, unknown>): string {
  const balance = bigIntishToString(note.balance);
  if (balance) return balance;
  const amount = bigIntishToString(note.amount);
  if (amount) return amount;
  const value = bigIntishToString(note.value);
  return value || "0";
}

function resolveNoteAssetSymbol(
  assetAddress: string,
  tokenMeta: Map<string, { symbol: string; decimals: number }>
): string | undefined {
  if (isPrivateBalanceNativeEth(assetAddress)) return "ETH";
  let key = assetAddress.toLowerCase();
  try {
    if (isAddress(assetAddress)) {
      key = getAddress(assetAddress).toLowerCase();
    }
  } catch {
    // keep lowercased raw address
  }
  return tokenMeta.get(key)?.symbol;
}

function formatNoteAmount(
  raw: string,
  assetAddress: string,
  tokenMeta: Map<string, { symbol: string; decimals: number }>
): string {
  try {
    const key = assetAddress.toLowerCase();
    const canonicalKey = isAddress(assetAddress)
      ? getAddress(assetAddress).toLowerCase()
      : key;
    const meta = tokenMeta.get(canonicalKey) ?? {
      symbol: isPrivateBalanceNativeEth(assetAddress) ? "ETH" : "UNKNOWN",
      decimals: 18,
    };
    return formatUnits(BigInt(raw), meta.decimals);
  } catch {
    return raw;
  }
}

export function mapPrivacyPoolsNotes(
  notes: unknown[],
  tokenMeta: Map<string, { symbol: string; decimals: number }>
): PrivateNoteRow[] {
  return notes.map((raw) => {
    const n = raw as Record<string, unknown>;
    const assetAddress = addressishToHex(n.assetAddress);
    const balanceRaw = noteBalanceRaw(n);
    const label = bigIntishToString(n.label);
    const precommitment = bigIntishToString(n.precommitment);
    return {
      protocol: "privacy-pools",
      label: label || undefined,
      balance_raw: balanceRaw,
      balance_formatted: formatNoteAmount(balanceRaw, assetAddress, tokenMeta),
      asset_address: assetAddress,
      asset_symbol: resolveNoteAssetSymbol(assetAddress, tokenMeta),
      approved: typeof n.approved === "boolean" ? n.approved : undefined,
      precommitment: precommitment || undefined,
      status:
        typeof n.approved === "boolean"
          ? n.approved
            ? "approved"
            : "pending"
          : undefined,
      deposit_index: bigIntishToString(n.deposit) || undefined,
    };
  });
}

export function mapTornadoNotes(
  notes: unknown[],
  tokenMeta: Map<string, { symbol: string; decimals: number }>
): PrivateNoteRow[] {
  return notes.map((raw) => {
    const n = raw as Record<string, unknown>;
    const assetAddress = addressishToHex(n.assetAddress);
    const balanceRaw = noteBalanceRaw(n);
    const commitment =
      n.commitment != null ? bigIntishToString(n.commitment) : "";
    const leafIndex =
      n.leafIndex != null
        ? String(n.leafIndex)
        : bigIntishToString(n.leafIndex);
    const depositTimestamp = bigIntishToString(n.timestamp);
    return {
      protocol: "tornado",
      balance_raw: balanceRaw,
      balance_formatted: formatNoteAmount(balanceRaw, assetAddress, tokenMeta),
      asset_address: assetAddress,
      asset_symbol: resolveNoteAssetSymbol(assetAddress, tokenMeta),
      pool: addressishToHex(n.pool),
      commitment: commitment || undefined,
      leaf_index: leafIndex || undefined,
      deposit_index: bigIntishToString(n.depositIndex) || undefined,
      deposit_timestamp: depositTimestamp || undefined,
      status: balanceRaw === "0" ? "spent" : "spendable",
    };
  });
}

export function mapRailgunNotes(
  notes: unknown[],
  tokenMeta: Map<string, { symbol: string; decimals: number }>
): PrivateNoteRow[] {
  return notes.map((raw) => {
    const n = raw as Record<string, unknown>;
    const asset = n.asset as { contract?: unknown } | undefined;
    const assetAddress = addressishToHex(asset?.contract);
    const balanceRaw = noteBalanceRaw(n);
    const poiStatus =
      typeof n.poiStatus === "string" && n.poiStatus.trim()
        ? n.poiStatus
        : undefined;
    return {
      protocol: "railgun",
      balance_raw: balanceRaw,
      balance_formatted: formatNoteAmount(balanceRaw, assetAddress, tokenMeta),
      asset_address: assetAddress,
      asset_symbol: resolveNoteAssetSymbol(assetAddress, tokenMeta),
      tree_number:
        n.treeNumber != null ? String(n.treeNumber) : undefined,
      leaf_index:
        n.leafIndex != null ? String(n.leafIndex) : undefined,
      blinded_commitment:
        typeof n.blindedCommitment === "string"
          ? n.blindedCommitment
          : undefined,
      memo: typeof n.memo === "string" && n.memo ? n.memo : undefined,
      railgun_address:
        typeof n.address === "string" ? n.address : undefined,
      status: poiStatus ?? "spendable",
    };
  });
}

export function filterNonZeroNotes(rows: PrivateNoteRow[]): PrivateNoteRow[] {
  return rows.filter((n) => {
    try {
      return BigInt(n.balance_raw) !== 0n;
    } catch {
      return true;
    }
  });
}

export type PrivateNotesByProtocol = Partial<
  Record<SupportedProtocol, PrivateNoteRow[]>
>;
