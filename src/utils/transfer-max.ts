import { makePublicClient } from "./rpc.js";

/** Standard EIP-1559 simple ETH transfer. */
export const ETH_TRANSFER_GAS_LIMIT = 21_000n;

/**
 * Conservative wei reserve for a native ETH transfer (gas × fee × 1.2).
 * Uses ~110% of latest base fee, same pattern as shield fee picking.
 */
export async function estimateEthTransferGasReserveWei(
  rpcUrl: string
): Promise<bigint> {
  const client = await makePublicClient(rpcUrl);
  const latest = await client.getBlock({ blockTag: "latest" });
  const base = latest.baseFeePerGas ?? 0n;
  let maxFeePerGas = (base * 110n) / 100n;

  const feeData = await client.estimateFeesPerGas();
  if (feeData.maxFeePerGas != null && feeData.maxFeePerGas > maxFeePerGas) {
    maxFeePerGas = feeData.maxFeePerGas;
  }
  if (maxFeePerGas === 0n && feeData.gasPrice != null) {
    maxFeePerGas = feeData.gasPrice;
  }
  if (maxFeePerGas === 0n) {
    throw new Error(
      "Could not determine gas price to compute ETH --amount-max."
    );
  }
  return (ETH_TRANSFER_GAS_LIMIT * maxFeePerGas * 12n) / 10n;
}

/** Max transferable amount from a public balance (ETH reserves gas; ERC-20 is full balance). */
export function transferMaxAmountFromBalance(
  balance: bigint,
  opts: { isEth: boolean; ethGasReserveWei?: bigint }
): bigint {
  if (!opts.isEth) {
    return balance > 0n ? balance : 0n;
  }
  const reserve = opts.ethGasReserveWei ?? 0n;
  if (balance <= reserve) return 0n;
  return balance - reserve;
}
