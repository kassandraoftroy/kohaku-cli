import { getRpcChainIdMatchingWallet } from "../utils/rpc.js";
import {
  expectedChainIdStringFromWalletDir,
  readWalletType,
} from "../utils/wallets-util.js";

export function walletNetworkLabel(walletDir: string): string {
  try {
    const t = readWalletType(walletDir);
    return t === "testnet" ? "Sepolia testnet" : "Ethereum mainnet";
  } catch {
    return "unknown network";
  }
}

export async function assertRpcMatchesWallet(
  rpcUrl: string,
  walletDir: string
): Promise<void> {
  await getRpcChainIdMatchingWallet(rpcUrl, walletDir);
}

export function formatWalletRpcMismatchError(
  rpcUrl: string,
  walletDir: string,
  cause: unknown
): string {
  const expected = expectedChainIdStringFromWalletDir(walletDir);
  const label = walletNetworkLabel(walletDir);
  const detail = cause instanceof Error ? cause.message : String(cause);
  return [
    "RPC network does not match this wallet.",
    "",
    `Wallet "${label}" expects chain ID ${expected}.`,
    `RPC: ${rpcUrl}`,
    "",
    detail,
    "",
    "Use an RPC URL for the correct network, or pick a different wallet.",
  ].join("\n");
}

export function isWalletRpcChainMismatch(cause: unknown): boolean {
  const msg = cause instanceof Error ? cause.message : String(cause);
  return msg.includes("does not match wallet chainId");
}

/** Short copy for inline TUI alerts (not a fatal exit). */
export function formatWalletRpcMismatchBrief(
  walletDir: string,
  cause?: unknown
): string {
  const expected = expectedChainIdStringFromWalletDir(walletDir);
  const label = walletNetworkLabel(walletDir);
  const detail = cause instanceof Error ? cause.message : "";
  const chainHint = detail.includes("chainId")
    ? detail
    : `expected chain ID ${expected}`;
  return `That RPC is the wrong network. This wallet uses ${label} (${chainHint}). Enter an RPC URL for ${label}.`;
}
