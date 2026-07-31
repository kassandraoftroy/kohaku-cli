/** Fetch Pimlico gas prices for ERC-4337 UserOperations. */

export type PimlicoUserOperationGasPrice = {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
};

type PimlicoGasPriceTier = {
  maxFeePerGas?: string;
  maxPriorityFeePerGas?: string;
};

async function fetchPimlicoGasPriceResult(
  bundlerUrl: string
): Promise<{ standard?: PimlicoGasPriceTier }> {
  const res = await fetch(bundlerUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "pimlico_getUserOperationGasPrice",
      params: [],
    }),
  });
  const json = (await res.json()) as {
    result?: { standard?: PimlicoGasPriceTier };
    error?: { message?: string };
  };
  if (!json.result?.standard) {
    throw new Error(
      json.error?.message ??
        "Failed to fetch bundler gas price (pimlico_getUserOperationGasPrice)."
    );
  }
  return json.result;
}

/** Fetch Pimlico `standard` maxFee + maxPriorityFee for UserOp fee estimation. */
export async function fetchPimlicoUserOperationGasPrice(
  bundlerUrl: string
): Promise<PimlicoUserOperationGasPrice> {
  const { standard } = await fetchPimlicoGasPriceResult(bundlerUrl);
  const maxFeeHex = standard?.maxFeePerGas;
  const maxPriorityHex = standard?.maxPriorityFeePerGas;
  if (!maxFeeHex || !maxPriorityHex) {
    throw new Error(
      "Failed to fetch bundler gas price (pimlico_getUserOperationGasPrice)."
    );
  }
  return {
    maxFeePerGas: BigInt(maxFeeHex),
    maxPriorityFeePerGas: BigInt(maxPriorityHex),
  };
}

/** Fetch Pimlico `standard.maxFeePerGas` for ERC-4337 fee estimates. */
export async function fetchPimlicoMaxFeePerGas(
  bundlerUrl: string
): Promise<bigint> {
  const fees = await fetchPimlicoUserOperationGasPrice(bundlerUrl);
  return fees.maxFeePerGas;
}
