import { recordSubmission } from "./activity-log.js";
/**
 * Tornado paymaster broadcast tuned for Tor-proxied Pimlico.
 *
 * Default viem HTTP timeout is 10s with retries on timeout. Tor often exceeds
 * that: the first eth_sendUserOperation reaches Pimlico, the client times out
 * and retries, then Pimlico returns "Already known".
 *
 * Fix: long timeout, no send retries, and on timeout / "Already known" recover
 * by checking the deterministic userOpHash (EntryPoint 0.8). Match the SDK's
 * acceptance/confirmation split: only wait() reports a successful receipt.
 */
import { BaseError, RpcRequestError, http, type Hash, type Hex } from "viem";
import { PaymasterBroadcastError, type PaymasterBroadcastResult } from "@kohaku-eth/tornado-cash";
import {
  createBundlerClient,
  entryPoint08Address,
  getUserOperationHash,
  type UserOperation,
} from "viem/account-abstraction";

const BUNDLER_HTTP_TIMEOUT_MS = 180_000;
const RECEIPT_WAIT_MS = 180_000;

export type SerializedUserOperation = {
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
  factory?: `0x${string}`;
  factoryData?: Hex;
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
  userOpHash?: Hash;
};

/** Never forward viem's full message or cause: they contain the signed userOp. */
function safeErrorText(err: unknown): string {
  return err instanceof BaseError
    ? [err.shortMessage, err.details].filter(Boolean).join(" ")
    : "Unknown error.";
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
    ...(op.factory ? { factory: op.factory, factoryData: op.factoryData } : {}),
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
  chainId: bigint,
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
  chainId: bigint,
  preparedHash?: Hash,
): Promise<Hash> {
  const client = createTorAwareBundlerClient(bundlerUrl);
  try {
    return (await client.request({
      method: "eth_sendUserOperation",
      params: [op, entryPoint],
    }, { retryCount: 0 })) as Hash;
  } catch (err) {
    const userOpHash = preparedHash ?? userOpHashFor(op, entryPoint, chainId);
    const rejection = err instanceof BaseError
      ? err.walk((cause) => cause instanceof RpcRequestError) as RpcRequestError | null
      : null;
    if (/already known/i.test(rejection?.details ?? "")) return userOpHash;
    const known = await client.request({
      method: "eth_getUserOperationByHash", params: [userOpHash],
    }).then((result) => result !== null).catch(() => false);
    if (known) return userOpHash;
    // A lost send response can still land even if the bundler only indexes mined ops.
    throw new PaymasterBroadcastError(rejection ? "not-accepted" : "unconfirmed",
      `${rejection ? "Bundler rejected" : "Could not confirm acceptance of"} userOp ${userOpHash}: ${safeErrorText(err)}`,
      { userOpHash });
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
  let userOpHash: Hash;
  try {
    userOpHash = await sendSerializedUserOperation(
      bundlerUrl, userOperation, entryPoint, chainId, withdrawal.userOpHash,
    );
  } catch (err) {
    if (err instanceof PaymasterBroadcastError && err.failure === "unconfirmed" && err.userOpHash) {
      recordSubmission({ userOpHash: err.userOpHash });
    }
    throw err;
  }
  const updateActivity = recordSubmission({ userOpHash });
  return { userOpHash, async wait() {
    let receipt;
    try {
      receipt = await client.waitForUserOperationReceipt({ hash: userOpHash, timeout: RECEIPT_WAIT_MS });
    } catch (err) {
      throw new PaymasterBroadcastError("unconfirmed",
        `Could not confirm userOp ${userOpHash}, it may still land: ${safeErrorText(err)}`, { userOpHash });
    }
    const txHash = receipt.receipt.transactionHash;
    updateActivity({ txHash, status: receipt.success ? "confirmed" : "reverted" });
    if (!receipt.success) throw new PaymasterBroadcastError("reverted",
      `User operation reverted: ${userOpHash} (tx ${txHash})`, { userOpHash, txHash });
    return { txHash };
  } };
}

/**
 * Drop-in for Tornado `paymasterClientFactory`, also used for PPv1. Preserve
 * input order and serialize withdrawals sharing an executor until it confirms.
 */
export function createTorAwarePaymasterBroadcaster(chainId: bigint): {
  broadcast: (
    withdrawals: PaymasterWithdrawal[]
  ) => Promise<PaymasterBroadcastResult[]>;
} {
  return {
    async broadcast(withdrawals) {
      const bySender = new Map<string, Promise<PaymasterBroadcastResult>>();
      return Promise.all(withdrawals.map((withdrawal) => {
        const key = withdrawal.userOperation.sender.toLowerCase();
        const previous = bySender.get(key);
        const result = (async () => {
          if (previous) await (await previous).wait();
          return broadcastOne(withdrawal, chainId);
        })();
        bySender.set(key, result);
        return result;
      }));
    },
  };
}
