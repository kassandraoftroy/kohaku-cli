import { type Address, type Hash } from "viem";
import { formatUserOperationRequest, getUserOperationHash, type UserOperation } from "viem/account-abstraction";
import { recordSubmission } from "./activity-log.js";

/** No send retries. Persist a hash before the only send, then require both receipt sources. */
export async function submitPreparedShieldUserOp(opts: {
  chainId: bigint; entryPointAddress: Address; userOperation: UserOperation<"0.8">;
  onSubmitted?: (hash: Hash) => void;
  send: (operation: ReturnType<typeof formatUserOperationRequest>) => Promise<Hash>;
  wait: (hash: Hash) => Promise<{ success: boolean; receipt: { transactionHash: Hash } }>;
  confirm: (hash: Hash) => Promise<{ status: string }>;
}): Promise<{ userOpHash: Hash; txHash: Hash }> {
  const userOpHash = getUserOperationHash({ chainId: Number(opts.chainId), entryPointAddress: opts.entryPointAddress,
    entryPointVersion: "0.8", userOperation: opts.userOperation });
  // Save first: even a process crash or lost eth_sendUserOperation response
  // leaves a hash to reconcile, and must not cause a second batch to start.
  opts.onSubmitted?.(userOpHash);
  try {
    const returnedHash = await opts.send(formatUserOperationRequest(opts.userOperation));
    if (returnedHash.toLowerCase() !== userOpHash.toLowerCase()) throw Object.assign(new Error("Bundler returned an unexpected UserOp hash."), { submissionStatus: "unknown" });
  } catch (error) {
    // Transport ambiguity and duplicates may already be accepted: only wait
    // for this exact hash, never retry the send or advance to another batch.
    if ((error as { submissionStatus?: string })?.submissionStatus === "unknown") throw error;
    const message = error instanceof Error ? error.message : String(error);
    let cause: unknown = error;
    let rejected = false;
    const seen = new Set<unknown>();
    while (cause && typeof cause === "object" && !seen.has(cause)) {
      seen.add(cause);
      const rpc = cause as { code?: unknown; cause?: unknown };
      if (typeof rpc.code === "number" && ((rpc.code <= -32500 && rpc.code >= -32599) ||
          [-32600, -32602, -32700].includes(rpc.code))) rejected = true;
      cause = rpc.cause;
    }
    if (rejected && !/already known/i.test(message)) {
      throw Object.assign(new Error(message, { cause: error }), { submissionStatus: "failed", userOpHash });
    }
  }
  const updateActivity = recordSubmission({ userOpHash });
  const receipt = await opts.wait(userOpHash);
  const chainReceipt = await opts.confirm(receipt.receipt.transactionHash);

  const success = receipt.success && chainReceipt.status !== "reverted";
  updateActivity({ txHash: receipt.receipt.transactionHash, status: success ? "confirmed" : "reverted" });
  if (!success) throw Object.assign(new Error(`User operation reverted: ${userOpHash} (tx ${receipt.receipt.transactionHash})`),
    { submissionStatus: "failed", userOpHash, txHash: receipt.receipt.transactionHash });
  return { userOpHash, txHash: receipt.receipt.transactionHash };
}
