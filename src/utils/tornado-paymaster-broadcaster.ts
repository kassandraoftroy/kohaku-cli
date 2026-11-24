import { recordSubmission } from "./activity-log.js";
/**
 * Activity tracking around the SDK's paymaster broadcaster, shared by Tornado
 * and PPv1. The SDK uses a 180s HTTP timeout, never retries sends, and routes
 * requests through Host.network. Keep its signed-hash, lookup, receipt, and
 * stale-nonce checks rather than maintaining a second broadcast implementation.
 */
import type { Host } from "@kohaku-eth/plugins";
import { type Hash, type Hex } from "viem";
import { createTCBroadcaster, PaymasterBroadcastError, type PaymasterBroadcastResult, type TCPaymasterBroadcastResponse } from "@kohaku-eth/tornado-cash";
import { getUserOperationHash, type UserOperation } from "viem/account-abstraction";

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

async function broadcastOne(
  withdrawal: PaymasterWithdrawal,
  chainId: bigint,
  host: Host,
): Promise<PaymasterBroadcastResult> {
  // Older prepared payloads lack a hash. Include factory fields when recovering
  // a SimpleAccount operation, as well as the chain known by the CLI.
  const userOpHash = withdrawal.userOpHash ?? userOpHashFor(
    withdrawal.userOperation, withdrawal.entryPointAddress, chainId,
  );
  // No custom paymasterClientFactory here: use the hardened SDK implementation.
  const broadcaster = createTCBroadcaster(host);
  let result: TCPaymasterBroadcastResponse | undefined;
  try {
    [result] = await broadcaster.broadcast({
      withdrawals: [{ ...withdrawal, userOpHash }],
    } as never);
  } catch (error) {
    if (error instanceof PaymasterBroadcastError && error.failure === "unconfirmed" && error.userOpHash) {
      recordSubmission({ userOpHash: error.userOpHash });
    }
    throw error;
  }
  if (!result || !("wait" in result)) {
    throw new Error("Paymaster broadcaster returned no confirmation handle.");
  }
  const updateActivity = recordSubmission({ userOpHash: result.id });
  const accepted = result;
  return {
    // The SDK validates this id as the signed 32-byte hash before accepting.
    userOpHash: accepted.id as Hash,
    async wait() {
      try {
        const confirmed = await accepted.wait();
        updateActivity({ txHash: confirmed.txHash, status: "confirmed" });
        return confirmed;
      } catch (error) {
        if (error instanceof PaymasterBroadcastError && error.failure === "reverted") {
          updateActivity({ txHash: error.txHash, status: "reverted" });
        }
        throw error;
      }
    },
  };
}

/**
 * Drop-in for Tornado `paymasterClientFactory`, also used for PPv1. Preserve
 * input order and serialize withdrawals sharing an executor until it confirms.
 */
export function createTorAwarePaymasterBroadcaster(chainId: bigint, host: Host): {
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
          return broadcastOne(withdrawal, chainId, host);
        })();
        bySender.set(key, result);
        return result;
      }));
    },
  };
}
