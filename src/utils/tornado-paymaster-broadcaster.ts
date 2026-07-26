/**
 * Tornado paymaster broadcast tuned for Tor-proxied Pimlico.
 *
 * Default viem HTTP timeout is 10s with retries on timeout. Tor often exceeds
 * that: the first eth_sendUserOperation reaches Pimlico, the client times out
 * and retries, then Pimlico returns "Already known". The SDK only warns, so
 * the CLI still prints "broadcast complete" while looking like a failure.
 *
 * Fix: long timeout, no send retries, and on timeout / "Already known" recover
 * by waiting on the deterministic userOpHash (EntryPoint 0.8).
 */
import { http, type Hash, type Hex } from "viem";
import {
  createBundlerClient,
  entryPoint08Address,
  getUserOperationHash,
  type UserOperation,
} from "viem/account-abstraction";

const BUNDLER_HTTP_TIMEOUT_MS = 180_000;
const RECEIPT_WAIT_MS = 180_000;

type SerializedUserOperation = {
  sender: `0x${string}`;
  nonce: `0x${string}`;
  callData: `0x${string}`;
  callGasLimit: `0x${string}`;
  verificationGasLimit: `0x${string}`;
  preVerificationGas: `0x${string}`;
  maxFeePerGas: `0x${string}`;
  maxPriorityFeePerGas: `0x${string}`;
  paymaster?: `0x${string}`;
  paymasterVerificationGasLimit?: `0x${string}`;
  paymasterPostOpGasLimit?: `0x${string}`;
  paymasterData?: `0x${string}`;
  signature: `0x${string}`;
  eip7702Auth?: {
    address: `0x${string}`;
    chainId: Hex;
    nonce: Hex;
    r: Hex;
    s: Hex;
    yParity: Hex;
  };
};

type PaymasterWithdrawal = {
  mode: "paymaster";
  bundlerUrl: string;
  entryPointAddress: `0x${string}`;
  userOperation: SerializedUserOperation;
};

type PaymasterBroadcastResult = { userOpHash: Hash };

function errorText(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const extra = [
    "details" in err ? String((err as { details?: unknown }).details) : "",
    "shortMessage" in err
      ? String((err as { shortMessage?: unknown }).shortMessage)
      : "",
    "name" in err ? String((err as { name?: unknown }).name) : "",
  ]
    .filter(Boolean)
    .join("\n");
  return `${err.message}\n${extra}`;
}

function isAlreadyKnownError(err: unknown): boolean {
  return /already known/i.test(errorText(err));
}

function isTimeoutError(err: unknown): boolean {
  const text = errorText(err);
  return (
    /timed?\s*out|TimeoutError|AbortError|The operation was aborted/i.test(
      text
    ) || ("name" in (err as object) && (err as { name: string }).name === "TimeoutError")
  );
}

function toUserOperation(op: SerializedUserOperation): UserOperation {
  return {
    sender: op.sender,
    nonce: BigInt(op.nonce),
    callData: op.callData,
    callGasLimit: BigInt(op.callGasLimit),
    verificationGasLimit: BigInt(op.verificationGasLimit),
    preVerificationGas: BigInt(op.preVerificationGas),
    maxFeePerGas: BigInt(op.maxFeePerGas),
    maxPriorityFeePerGas: BigInt(op.maxPriorityFeePerGas),
    signature: op.signature,
    ...(op.paymaster
      ? {
          paymaster: op.paymaster,
          paymasterVerificationGasLimit: BigInt(
            op.paymasterVerificationGasLimit ?? "0x0"
          ),
          paymasterPostOpGasLimit: BigInt(op.paymasterPostOpGasLimit ?? "0x0"),
          paymasterData: (op.paymasterData ?? "0x") as Hex,
        }
      : {}),
  } as UserOperation;
}

function userOpHashFor(
  op: SerializedUserOperation,
  entryPoint: `0x${string}`,
  chainId: bigint
): Hash {
  return getUserOperationHash({
    userOperation: toUserOperation(op),
    entryPointAddress: entryPoint,
    entryPointVersion: "0.8",
    chainId: Number(chainId),
  });
}

function createTorAwareBundlerClient(bundlerUrl: string) {
  return createBundlerClient({
    transport: http(bundlerUrl, {
      // Tor RTT to public.pimlico.io regularly exceeds viem's 10s default.
      timeout: BUNDLER_HTTP_TIMEOUT_MS,
      // Timeouts must not re-send eth_sendUserOperation (causes "Already known").
      retryCount: 0,
    }),
  });
}

async function sendSerializedUserOperation(
  bundlerUrl: string,
  op: SerializedUserOperation,
  entryPoint: `0x${string}`,
  chainId: bigint
): Promise<Hash> {
  const client = createTorAwareBundlerClient(bundlerUrl);
  try {
    return (await client.request({
      method: "eth_sendUserOperation",
      params: [op, entryPoint],
    })) as Hash;
  } catch (err) {
    // First submit may have landed under Tor even when the client saw timeout
    // or a duplicate-submit "Already known".
    if (!isAlreadyKnownError(err) && !isTimeoutError(err)) throw err;
    return userOpHashFor(op, entryPoint, chainId);
  }
}

async function broadcastOne(
  withdrawal: PaymasterWithdrawal,
  chainId: bigint
): Promise<PaymasterBroadcastResult> {
  const { bundlerUrl, entryPointAddress, userOperation } = withdrawal;
  const entryPoint =
    entryPointAddress.toLowerCase() === entryPoint08Address.toLowerCase()
      ? entryPoint08Address
      : entryPointAddress;
  const client = createTorAwareBundlerClient(bundlerUrl);
  const userOpHash = await sendSerializedUserOperation(
    bundlerUrl,
    userOperation,
    entryPoint,
    chainId
  );
  await client.waitForUserOperationReceipt({
    hash: userOpHash,
    timeout: RECEIPT_WAIT_MS,
  });
  return { userOpHash };
}

/**
 * Drop-in for Tornado `paymasterClientFactory`: same grouping semantics as the
 * SDK PaymasterBroadcaster, but Tor-safe HTTP settings.
 */
export function createTorAwarePaymasterBroadcaster(chainId: bigint): {
  broadcast: (
    withdrawals: PaymasterWithdrawal[]
  ) => Promise<PaymasterBroadcastResult[]>;
} {
  return {
    async broadcast(withdrawals) {
      const bySender = new Map<string, PaymasterWithdrawal[]>();
      for (const w of withdrawals) {
        const key = w.userOperation.sender.toLowerCase();
        const group = bySender.get(key) ?? [];
        group.push(w);
        bySender.set(key, group);
      }

      const groupResults = await Promise.allSettled(
        [...bySender.values()].map(async (group) => {
          const out: PaymasterBroadcastResult[] = [];
          for (const w of group) {
            out.push(await broadcastOne(w, chainId));
          }
          return out;
        })
      );

      const failed = groupResults.filter((r) => r.status === "rejected");
      if (failed.length > 0) {
        const reasons = failed
          .map((e) =>
            e.status === "rejected"
              ? e.reason instanceof Error
                ? e.reason.message
                : String(e.reason)
              : ""
          )
          .join("\n");
        throw new Error(`Some paymaster withdrawals failed.\n${reasons}`);
      }

      return groupResults
        .filter(
          (r): r is PromiseFulfilledResult<PaymasterBroadcastResult[]> =>
            r.status === "fulfilled"
        )
        .flatMap((r) => r.value);
    },
  };
}
