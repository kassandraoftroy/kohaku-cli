import type { AssetAmount } from "@kohaku-eth/plugins";
import { isPendingPrivateBalanceRow, isPrivateBalanceNativeEth, privateBalanceRowMatchesUnshieldToken, wethAddressForChain } from "../utils/tokens-util.js";
import type { ResolvedTokenMeta } from "../utils/tokens-util.js";
import type { SupportedProtocol } from "../utils/plugins.js";

export function privateTransferBalanceSummary(
  rows: AssetAmount[], tokenMeta: ResolvedTokenMeta, chainId: bigint, protocol: SupportedProtocol,
): { total: bigint; spendable: bigint; feeToken: bigint } {
  let total = 0n, spendable = 0n, feeToken = 0n;
  for (const row of rows) {
    const asset = row.asset as { __type?: string; contract?: string | bigint };
    const address = asset.__type === "native" ? "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
      : typeof asset.contract === "bigint" ? `0x${asset.contract.toString(16).padStart(40, "0")}`
      : asset.contract;
    if (!address) continue;
    const available = !isPendingPrivateBalanceRow(row);
    if (available && address.toLowerCase() === wethAddressForChain(chainId)?.toLowerCase()) feeToken += row.amount;
    const matches = protocol === "privacy-pools"
      ? tokenMeta.isEth ? isPrivateBalanceNativeEth(address) : address.toLowerCase() === tokenMeta.tokenAddress.toLowerCase()
      : privateBalanceRowMatchesUnshieldToken(address, tokenMeta, chainId, protocol);
    if (matches) { total += row.amount; if (available) spendable += row.amount; }
  }
  return { total, spendable, feeToken };
}
