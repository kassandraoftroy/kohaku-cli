import { keccak256, type Hash, type Hex } from "viem";
import { kohakuPrivateFetch, withTor } from "./tor.js";

/** Separate from RPC_URL: only chain verification and signed sends go here. */
export const DEFAULT_SUBMIT_RPC_URLS: Readonly<Record<string, string>> = {
  "1": "https://ethereum-rpc.publicnode.com",
  "11155111": "https://ethereum-sepolia-rpc.publicnode.com",
};

export function resolveSubmitRpcUrl(chainId: bigint): string {
  const input = process.env.KOHAKU_SUBMIT_RPC_URL?.trim() || DEFAULT_SUBMIT_RPC_URLS[String(chainId)];
  if (!input) throw new Error("Set KOHAKU_SUBMIT_RPC_URL to a transaction submission endpoint for this chain.");
  let url: URL;
  try { url = new URL(input); }
  catch { throw new Error("KOHAKU_SUBMIT_RPC_URL must be a complete HTTP(S) URL."); }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.username || url.password || url.hash ||
      (url.protocol !== "https:" && !(url.protocol === "http:" && (local || url.hostname.endsWith(".onion"))))) {
    throw new Error("The submit endpoint must use HTTPS, onion HTTP, or local HTTP, without URL credentials or a fragment.");
  }
  return url.href;
}

export class TransactionSubmissionError extends Error {
  constructor(readonly txHash: Hash, detail: string) {
    super(`Transaction ${txHash} has an unknown submission outcome. ${detail} Check this hash before retrying.`);
    this.name = "TransactionSubmissionError";
  }
}

async function rpc(url: string, method: string, params: unknown[]): Promise<unknown> {
  const response = await kohakuPrivateFetch(url, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(180_000), credentials: "omit", redirect: "error", cache: "no-store",
  });
  if (!response.ok) throw new Error(`Submission endpoint returned HTTP ${response.status}.`);
  const body = await response.json() as { jsonrpc?: unknown; id?: unknown; result?: unknown; error?: { code?: unknown } };
  if (!body || body.jsonrpc !== "2.0" || body.id !== 1 || body.error || !Object.hasOwn(body, "result")) {
    const code = Number.isInteger(body?.error?.code) ? ` (RPC code ${body.error!.code})` : "";
    // Never include an endpoint-provided message: it can echo the signed bytes.
    throw new Error(`Submission endpoint returned an invalid or rejected response${code}.`);
  }
  return body.result;
}

/** Send once over Tor, with no retry or fallback to the configured read RPC. */
export async function submitSignedTransaction(
  serializedTransaction: Hex,
  chainId: bigint,
  onAttempt: (hash: Hash) => void,
): Promise<Hash> {
  const url = resolveSubmitRpcUrl(chainId);
  const hash = keccak256(serializedTransaction);
  return withTor(true, {}, async () => {
    let submittedChain: unknown;
    try { submittedChain = await rpc(url, "eth_chainId", []); }
    catch { throw new Error("Could not verify the transaction submission endpoint's chain. No signed transaction was sent."); }
    if (typeof submittedChain !== "string" || !/^0x[0-9a-f]+$/i.test(submittedChain) || BigInt(submittedChain) !== chainId) {
      throw new Error("The transaction submission endpoint is on a different or invalid chain. No signed transaction was sent.");
    }
    // Retain the deterministic hash even if the response is lost after sending.
    onAttempt(hash);
    let returned: unknown;
    try { returned = await rpc(url, "eth_sendRawTransaction", [serializedTransaction]); }
    catch { throw new TransactionSubmissionError(hash, "The submit endpoint did not confirm acceptance."); }
    if (typeof returned !== "string" || returned.toLowerCase() !== hash.toLowerCase()) {
      throw new TransactionSubmissionError(hash, "The submit endpoint returned a different transaction hash.");
    }
    return hash;
  });
}
