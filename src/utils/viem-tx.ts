import { recordSubmission } from "./activity-log.js";
import {
  createWalletClient,
  custom,
  encodeFunctionData,
  type Abi,
  type Address,
  type Chain,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import type { KohakuPublicClient } from "./rpc.js";
import { submitSignedTransaction, TransactionSubmissionError } from "./transaction-submission.js";

export type KohakuWalletClient = ReturnType<typeof createWalletClient>;
type SubmissionUpdate = ReturnType<typeof recordSubmission>;
const submissionUpdates = new WeakMap<KohakuWalletClient, Map<string, SubmissionUpdate>>();

function normalizePrivateKey(priv: string): Hex {
  const hex = priv.startsWith("0x") ? priv : `0x${priv}`;
  return hex as Hex;
}

export function addressFromPrivateKey(priv: string): Address {
  return privateKeyToAccount(normalizePrivateKey(priv)).address;
}

export function makeWalletClient(
  priv: string,
  publicClient: KohakuPublicClient,
  _rpcUrl: string
): KohakuWalletClient {
  const account = privateKeyToAccount(normalizePrivateKey(priv));
  const updates = new Map<string, SubmissionUpdate>();
  const wallet = createWalletClient({
    account,
    chain: publicClient.chain as Chain,
    transport: custom({ request: async ({ method, params }) => {
      if (method === "eth_sendRawTransaction") {
        const raw = (params as [Hex])[0];
        return submitSignedTransaction(raw, BigInt(publicClient.chain.id), (hash) => {
          updates.set(hash, recordSubmission({ txHash: hash }));
        });
      }
      // Signing metadata, nonce/gas reads and simulations retain RPC_URL.
      return publicClient.request({ method, params } as never);
    } }, { retryCount: 0 }),
  });
  submissionUpdates.set(wallet, updates);
  return wallet;
}

export function encodeContractCall(
  abi: Abi | readonly unknown[],
  functionName: string,
  args: readonly unknown[]
): Hex {
  return encodeFunctionData({
    abi: abi as Abi,
    functionName,
    args,
  });
}

export async function simulateCallOrThrow(
  client: KohakuPublicClient,
  tx: {
    to: Address | string;
    from: Address | string;
    data?: Hex | string;
    value?: bigint;
    gas?: bigint;
  },
  stepLabel: string
): Promise<void> {
  try {
    await client.call({
      to: tx.to as Address,
      account: tx.from as Address,
      data: (tx.data ?? "0x") as Hex,
      value: tx.value,
      gas: tx.gas,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`${stepLabel} simulation failed: ${msg}`);
  }
}

export async function sendTransactionAndWait(
  walletClient: KohakuWalletClient,
  publicClient: KohakuPublicClient,
  tx: {
    to: Address | string;
    data?: Hex | string;
    value?: bigint;
    gas?: bigint;
    maxFeePerGas?: bigint;
    maxPriorityFeePerGas?: bigint;
  }
): Promise<`0x${string}`> {
  let hash: `0x${string}`;
  try {
    hash = await walletClient.sendTransaction({
      account: walletClient.account!,
      chain: walletClient.chain,
      to: tx.to as Address,
      data: (tx.data ?? "0x") as Hex,
      value: tx.value ?? 0n,
      gas: tx.gas,
      ...(tx.maxFeePerGas != null ? { maxFeePerGas: tx.maxFeePerGas } : {}),
      ...(tx.maxPriorityFeePerGas != null
        ? { maxPriorityFeePerGas: tx.maxPriorityFeePerGas }
        : {}),
    });
  } catch (error) {
    // viem wraps transport errors with request arguments. Preserve our safe
    // deterministic-hash error without exposing the signed transaction body.
    let current: unknown = error;
    const seen = new Set<unknown>();
    while (current && typeof current === "object" && !seen.has(current)) {
      if (current instanceof TransactionSubmissionError) throw current;
      seen.add(current);
      current = (current as { cause?: unknown }).cause;
    }
    throw error;
  }
  const updates = submissionUpdates.get(walletClient);
  const updateActivity = updates?.get(hash) ?? recordSubmission({ txHash: hash });
  updates?.delete(hash);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success" && receipt.status !== "reverted") {
    throw new Error(`Transaction ${hash} has no confirmed receipt status. Check this hash before retrying.`);
  }
  updateActivity({ status: receipt.status === "reverted" ? "reverted" : "confirmed" });
  if (receipt.status === "reverted") throw new Error(`Transaction reverted: ${hash}`);
  return hash;
}
