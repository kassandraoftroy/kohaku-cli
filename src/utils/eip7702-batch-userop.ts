/**
 * Batch multiple calls into one ERC-4337 UserOperation via EIP-7702 delegation
 * to Simple7702Account, submitted through Pimlico's public bundler.
 */
import {
  http,
  isAddressEqual,
  type Address,
  type Hash,
  type Hex,
} from "viem";
import {
  createBundlerClient,
  toSimple7702SmartAccount,
} from "viem/account-abstraction";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";

import {
  buildFeePreview,
  estimateEoaTxFeePreview,
  type FeePreview,
} from "./fee-preview.js";
import { fetchPimlicoUserOperationGasPrice } from "./pimlico-gas.js";
import {
  railgunPimlicoBundlerUrl,
  type KohakuPublicClient,
} from "./rpc.js";
import { SIMPLE_7702_IMPLEMENTATION } from "./simple-7702.js";

const BUNDLER_HTTP_TIMEOUT_MS = 180_000;
const RECEIPT_WAIT_MS = 180_000;

/** Rough AA overhead when prepareUserOperation is unavailable (no private key). */
const EIP7702_AA_OVERHEAD_GAS = 250_000n;

export type Eip7702BatchCall = {
  to: Address | string;
  data?: Hex | string;
  value?: bigint;
};

export type Eip7702BatchUserOpResult = {
  userOpHash: Hash;
  txHash: Hash;
  /** True when this UserOp included a fresh EIP-7702 authorization. */
  delegatedInUserOp: boolean;
  implementation: typeof SIMPLE_7702_IMPLEMENTATION;
};

function normalizePrivateKey(priv: string): Hex {
  const hex = priv.startsWith("0x") ? priv : `0x${priv}`;
  return hex as Hex;
}

function hasNonEmptyCode(code: string | undefined | null): boolean {
  const c = (code ?? "0x").trim().toLowerCase();
  return c !== "0x" && c !== "";
}

function toCalls(calls: readonly Eip7702BatchCall[]) {
  return calls.map((call) => ({
    to: call.to as Address,
    data: (call.data ?? "0x") as Hex,
    value: call.value ?? 0n,
  }));
}

/**
 * Whether `address` already delegates to Simple7702 via EIP-7702.
 * Throws if the account has non-7702 contract code (cannot re-delegate).
 */
export async function needsSimple7702Authorization(
  client: KohakuPublicClient,
  address: Address
): Promise<boolean> {
  const [code, delegation] = await Promise.all([
    client.getCode({ address }),
    client.getDelegation({ address }),
  ]);

  if (hasNonEmptyCode(code) && !delegation) {
    throw new Error(
      `Account ${address} has contract code and cannot be EIP-7702 delegated for batched transact-raw.`
    );
  }

  if (
    delegation &&
    isAddressEqual(delegation, SIMPLE_7702_IMPLEMENTATION)
  ) {
    return false;
  }
  return true;
}

async function signAuthIfNeeded(
  client: KohakuPublicClient,
  owner: PrivateKeyAccount,
  needsAuth: boolean
) {
  if (!needsAuth) return undefined;
  const nonce = await client.getTransactionCount({
    address: owner.address,
    blockTag: "pending",
  });
  return owner.signAuthorization({
    address: SIMPLE_7702_IMPLEMENTATION,
    chainId: client.chain.id,
    nonce,
  });
}

function createPimlicoBundlerClient(opts: {
  client: KohakuPublicClient;
  account: Awaited<ReturnType<typeof toSimple7702SmartAccount>>;
  chainId: bigint;
}) {
  const bundlerUrl = railgunPimlicoBundlerUrl(opts.chainId);
  return {
    bundlerUrl,
    bundlerClient: createBundlerClient({
      account: opts.account,
      client: opts.client,
      chain: opts.client.chain,
      transport: http(bundlerUrl, {
        timeout: BUNDLER_HTTP_TIMEOUT_MS,
        retryCount: 0,
      }),
      userOperation: {
        estimateFeesPerGas: async () =>
          fetchPimlicoUserOperationGasPrice(bundlerUrl),
      },
    }),
  };
}

function feeFromPreparedUserOp(prepared: {
  callGasLimit?: bigint;
  verificationGasLimit?: bigint;
  preVerificationGas?: bigint;
  maxFeePerGas?: bigint;
}): FeePreview {
  const callGasLimit = prepared.callGasLimit ?? 0n;
  const verificationGasLimit = prepared.verificationGasLimit ?? 0n;
  const preVerificationGas = prepared.preVerificationGas ?? 0n;
  const maxFeePerGas = prepared.maxFeePerGas ?? 0n;
  const gasLimit = callGasLimit + verificationGasLimit + preVerificationGas;
  const estimatedMax = gasLimit * maxFeePerGas;
  return buildFeePreview({
    kind: "eip7702-userop",
    amount: estimatedMax,
    decimals: 18,
    asset: "ETH",
    maxFeePerGasWei: maxFeePerGas,
    gasLimit,
    note: "bundler gas limits × maxFeePerGas; refunded unused",
  });
}

/**
 * Estimate the max ETH fee for a batched EIP-7702 UserOp (prepare, do not send).
 * `prepareUserOperation` / bundler gas estimate is also the batch "simulation":
 * calls run in order under one account context (so approve→spend does not
 * false-positive the way isolated eth_calls would).
 *
 * Without a private key, falls back to per-call gas estimates + AA overhead ×
 * Pimlico price (no execution simulation).
 */
export async function estimateEip7702BatchUserOpFee(opts: {
  client: KohakuPublicClient;
  chainId: bigint;
  senderAddress: string;
  calls: readonly Eip7702BatchCall[];
  privateKey?: string;
}): Promise<FeePreview> {
  if (opts.calls.length === 0) {
    throw new Error("Cannot estimate fee for an empty EIP-7702 call list.");
  }

  if (opts.privateKey) {
    const owner = privateKeyToAccount(normalizePrivateKey(opts.privateKey));
    const needsAuth = await needsSimple7702Authorization(
      opts.client,
      owner.address
    );
    const account = await toSimple7702SmartAccount({
      client: opts.client,
      owner,
      implementation: SIMPLE_7702_IMPLEMENTATION,
    });
    const { bundlerClient } = createPimlicoBundlerClient({
      client: opts.client,
      account,
      chainId: opts.chainId,
    });
    const authorization = await signAuthIfNeeded(
      opts.client,
      owner,
      needsAuth
    );
    const prepared = await bundlerClient.prepareUserOperation({
      account,
      calls: toCalls(opts.calls),
      ...(authorization ? { authorization } : {}),
    });
    return feeFromPreparedUserOp(prepared);
  }

  // No key: rough upper bound from call gas + fixed AA overhead.
  const bundlerUrl = railgunPimlicoBundlerUrl(opts.chainId);
  const { maxFeePerGas } = await fetchPimlicoUserOperationGasPrice(bundlerUrl);
  let callGas = 0n;
  for (const call of opts.calls) {
    const part = await estimateEoaTxFeePreview(opts.client, {
      to: call.to,
      from: opts.senderAddress,
      data: call.data,
      value: call.value,
    });
    callGas += BigInt(part.gasLimit ?? "100000");
  }
  const gasLimit = callGas + EIP7702_AA_OVERHEAD_GAS;
  return buildFeePreview({
    kind: "eip7702-userop",
    amount: gasLimit * maxFeePerGas,
    decimals: 18,
    asset: "ETH",
    maxFeePerGasWei: maxFeePerGas,
    gasLimit,
    note: "rough estimate (no key for bundler prepare); actual may differ",
  });
}

/**
 * Submit `calls` as a single UserOperation. Includes EIP-7702 authorization in
 * the same UserOp when the sender is not already delegated to Simple7702.
 */
export async function sendEip7702BatchUserOperation(opts: {
  client: KohakuPublicClient;
  privateKey: string;
  chainId: bigint;
  calls: readonly Eip7702BatchCall[];
}): Promise<Eip7702BatchUserOpResult> {
  if (opts.calls.length === 0) {
    throw new Error("Cannot submit an empty EIP-7702 UserOperation call list.");
  }

  const owner = privateKeyToAccount(normalizePrivateKey(opts.privateKey));
  const needsAuth = await needsSimple7702Authorization(
    opts.client,
    owner.address
  );

  const account = await toSimple7702SmartAccount({
    client: opts.client,
    owner,
    implementation: SIMPLE_7702_IMPLEMENTATION,
  });

  const { bundlerClient } = createPimlicoBundlerClient({
    client: opts.client,
    account,
    chainId: opts.chainId,
  });

  const authorization = await signAuthIfNeeded(opts.client, owner, needsAuth);
  const calls = toCalls(opts.calls);

  const userOpHash = await bundlerClient.sendUserOperation({
    account,
    calls,
    ...(authorization ? { authorization } : {}),
  });

  const receipt = await bundlerClient.waitForUserOperationReceipt({
    hash: userOpHash,
    timeout: RECEIPT_WAIT_MS,
  });

  return {
    userOpHash,
    txHash: receipt.receipt.transactionHash,
    delegatedInUserOp: needsAuth,
    implementation: SIMPLE_7702_IMPLEMENTATION,
  };
}
