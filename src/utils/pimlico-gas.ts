/** Fetch Pimlico `standard.maxFeePerGas` for ERC-4337 fee estimates. */
export async function fetchPimlicoMaxFeePerGas(
  bundlerUrl: string
): Promise<bigint> {
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
    result?: { standard?: { maxFeePerGas?: string } };
    error?: { message?: string };
  };
  const hex = json.result?.standard?.maxFeePerGas;
  if (!hex) {
    throw new Error(
      json.error?.message ??
        "Failed to fetch bundler gas price (pimlico_getUserOperationGasPrice)."
    );
  }
  return BigInt(hex);
}
