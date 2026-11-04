import { makePublicClient, disposePublicClient, type KohakuPublicClient } from "./rpc.js";
import { resolveEip1559Fees, buildFeePreview } from "./fee-preview.js";
import type { Address } from "viem";

/** Prepare the exact gas/fee caps used for both max sizing and signing. */
export async function prepareEthMaxTransfer(client: KohakuPublicClient, from: string, to: string) {
  const balance = await client.getBalance({ address: from as Address, blockTag: "pending" });
  const fees = await resolveEip1559Fees(client);
  if (fees.maxFeePerGas <= 0n) throw new Error("Could not determine transfer gas price.");
  let gas = 21_000n;
  let value = 1n;
  for (let attempt = 0; attempt < 4; attempt++) {
    const estimate = await client.estimateGas({ account: from as Address, to: to as Address, value });
    const nextGas = (estimate * 12n + 9n) / 10n;
    gas = nextGas > gas ? nextGas : gas;
    const nextValue = balance - gas * fees.maxFeePerGas;
    if (nextValue <= 0n) throw new Error("Insufficient ETH after reserving transfer gas.");
    if (nextValue === value) return {
      value, gas, ...fees,
      preview: { ...buildFeePreview({ kind: "network-gas", amount: gas * fees.maxFeePerGas,
        decimals: 18, asset: "ETH", gasLimit: gas, maxFeePerGasWei: fees.maxFeePerGas,
        note: "reserved gas × pinned maxFeePerGas" }), maxPriorityFeePerGasWei: fees.maxPriorityFeePerGas.toString() },
    };
    value = nextValue;
  }
  throw new Error("Transfer gas did not stabilize. Retry with an explicit amount.");
}

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
  try {
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
  } finally { disposePublicClient(client); }
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
