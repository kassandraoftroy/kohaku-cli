export function etherscanTxUrl(chainId: bigint, txHash: string): string {
  const host = chainId === 11155111n ? "sepolia.etherscan.io" : "etherscan.io";
  return `https://${host}/tx/${txHash}`;
}

export function extractTxHash(text: string): string | null {
  const m = text.match(/0x[a-fA-F0-9]{64}/);
  return m?.[0] ?? null;
}
