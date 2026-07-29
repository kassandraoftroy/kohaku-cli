import type { AssetAmount } from "@kohaku-eth/plugins";
import { formatUnits, getAddress, isAddress } from "viem";

import type { BalanceItem } from "./balances-snapshot.js";
import { USD_VALUE_UNAVAILABLE } from "./usd-values.js";
import {
  isPrivateBalanceNativeEth,
  isSpendablePrivateBalanceTag,
  privateBalanceStatusLabel,
} from "../utils/tokens-util.js";

export function mapPrivateBalanceRows(
  rows: AssetAmount[],
  tokenMeta: Map<string, { symbol: string; decimals: number }>
): BalanceItem[] {
  return rows.map((row) => {
    const asset = row.asset as { __type?: string; contract?: unknown } | undefined;
    const amount = row.amount;
    const tag = "tag" in row ? (row as { tag?: string }).tag : undefined;
    const spendable = isSpendablePrivateBalanceTag(tag);
    const status = spendable
      ? "spendable"
      : privateBalanceStatusLabel(tag!);

    if (!asset || asset.__type !== "erc20") {
      const symbol = spendable ? "UNKNOWN" : "UNKNOWN (pending)";
      return {
        symbol,
        token_address: "---",
        decimals: 18,
        raw_token_holdings: amount.toString(),
        formatted_token_holdings: formatUnits(amount, 18),
        usd_value: USD_VALUE_UNAVAILABLE,
        status,
      };
    }
    const raw = asset.contract;
    let addrStr: string;
    if (typeof raw === "string") addrStr = raw;
    else if (typeof raw === "bigint") {
      addrStr = `0x${raw.toString(16).padStart(40, "0")}`;
    } else {
      addrStr = "---";
    }
    const isEth = isPrivateBalanceNativeEth(addrStr);
    const key =
      isEth || !isAddress(addrStr)
        ? null
        : (getAddress(addrStr).toLowerCase() as string);
    const meta = key ? tokenMeta.get(key) : { symbol: "ETH", decimals: 18 };
    const decimals = meta?.decimals ?? 18;
    const baseSymbol = meta?.symbol ?? "UNKNOWN";
    const symbol = spendable ? baseSymbol : `${baseSymbol} (pending)`;
    const tokenAddr =
      isEth || !isAddress(addrStr) ? "---" : getAddress(addrStr);
    return {
      symbol,
      token_address: tokenAddr,
      decimals,
      raw_token_holdings: amount.toString(),
      formatted_token_holdings: formatUnits(amount, decimals),
      usd_value: USD_VALUE_UNAVAILABLE,
      status,
    };
  });
}
