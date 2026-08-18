import {
  encodeAbiParameters,
  encodeFunctionData,
  keccak256,
  parseAbi,
} from "viem";

import { makePublicClient, disposePublicClient, type KohakuPublicClient } from "./rpc.js";
import { SIMPLE_7702_IMPLEMENTATION } from "./simple-7702.js";
import {
  estimateTornadoPaymasterFee,
  padTornadoTailForwardFee,
  tornadoWithdrawalCallGasLimit,
} from "./tornado-paymaster-gas.js";

export type TornadoTailCall = {
  to: `0x${string}`;
  data: `0x${string}`;
  value: bigint;
};

/** Same EIP-7702 SimpleAccount impl the Tornado paymaster SDK delegates to. */
export const TORNADO_SIMPLE_7702_IMPLEMENTATION = SIMPLE_7702_IMPLEMENTATION;

/**
 * ETH left on the simulating account when the unshielded asset is an ERC-20.
 * Needed because we estimate as `from=account` (self `execute` / `executeBatch`).
 */
export const TORNADO_TAIL_SIM_GAS_STIPEND_WEI = 10n ** 18n;

const EXECUTE_ABI = parseAbi([
  "function execute(address target, uint256 value, bytes data)",
  "function executeBatch((address target, uint256 value, bytes data)[] calls)",
]);

const ERC20_BALANCE_ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)",
]);
const ERC20_TRANSFER_ABI = parseAbi([
  "function transfer(address to, uint256 amount) returns (bool)",
]);

/** ~10% headroom on measured execution-tail gas before feeding SDK fee math. */
const TAIL_GAS_OVERHEAD_NUM = 11n;
const TAIL_GAS_OVERHEAD_DEN = 10n;

const MAX_REFINE_ITERS = 2;
/** Max ERC-20 `_balances` mapping base slots to probe (OZ / USDC / etc.). */
const MAX_ERC20_BALANCE_SLOTS = 100;

type JsonRpcProviderLike = Pick<KohakuPublicClient, "request">;

export type TornadoTailFundAsset =
  | { kind: "native" }
  | { kind: "erc20"; token: `0x${string}` };

/** Leftover `token.transfer(to, amount)` baked ahead of user `--tail-calls`. */
export function encodeTornadoErc20TransferTailCall(
  token: `0x${string}`,
  to: `0x${string}`,
  amount: bigint
): TornadoTailCall {
  return {
    to: token,
    value: 0n,
    data: encodeFunctionData({
      abi: ERC20_TRANSFER_ABI,
      functionName: "transfer",
      args: [to, amount],
    }),
  };
}

type StateOverride = Record<
  string,
  {
    balance?: string;
    code?: string;
    stateDiff?: Record<string, string>;
  }
>;

function encodeAccountCalls(calls: readonly TornadoTailCall[]): `0x${string}` {
  if (calls.length === 0) {
    throw new Error("Cannot estimate gas for an empty tail-call list.");
  }
  if (calls.length === 1) {
    const call = calls[0]!;
    return encodeFunctionData({
      abi: EXECUTE_ABI,
      functionName: "execute",
      args: [call.to, call.value, call.data],
    });
  }
  return encodeFunctionData({
    abi: EXECUTE_ABI,
    functionName: "executeBatch",
    args: [calls.map((c) => ({ target: c.to, value: c.value, data: c.data }))],
  });
}

function toHexQuantity(value: bigint): `0x${string}` {
  return `0x${value.toString(16)}`;
}

/** Apply the required 10% overhead on a raw eth_estimateGas measurement. */
export function withTailCallsGasOverhead(measuredGas: bigint): bigint {
  return (measuredGas * TAIL_GAS_OVERHEAD_NUM) / TAIL_GAS_OVERHEAD_DEN;
}

function toBytes32(value: bigint): `0x${string}` {
  return `0x${value.toString(16).padStart(64, "0")}`;
}

/** Solidity `mapping(address => uint256)` at `baseSlot`: keccak256(abi.encode(account, baseSlot)). */
function solidityMappingSlot(
  account: `0x${string}`,
  baseSlot: bigint
): `0x${string}` {
  return keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "uint256" }],
      [account, baseSlot]
    )
  );
}

/** Vyper-style `HashMap`: keccak256(abi.encode(baseSlot, account)). */
function vyperMappingSlot(
  account: `0x${string}`,
  baseSlot: bigint
): `0x${string}` {
  return keccak256(
    encodeAbiParameters(
      [{ type: "uint256" }, { type: "address" }],
      [baseSlot, account]
    )
  );
}

async function readErc20Balance(
  provider: JsonRpcProviderLike,
  token: `0x${string}`,
  account: `0x${string}`,
  stateOverride?: StateOverride
): Promise<bigint> {
  const data = encodeFunctionData({
    abi: ERC20_BALANCE_ABI,
    functionName: "balanceOf",
    args: [account],
  });
  const params: unknown[] = [{ to: token, data }, "latest"];
  if (stateOverride) params.push(stateOverride);
  const result = (await provider.request({
    method: "eth_call",
    params: params as never,
  })) as string;
  return BigInt(result === "0x" ? "0x0" : result);
}

/**
 * Find the storage slot that backs `balanceOf(account)` by probing common
 * mapping layouts with a stateDiff override (Foundry `deal`-style).
 */
export async function findErc20BalanceStorageSlot(
  provider: JsonRpcProviderLike,
  token: `0x${string}`,
  account: `0x${string}`,
  probeAmount: bigint = 10n ** 18n + 7n
): Promise<{ slot: `0x${string}`; layout: "solidity" | "vyper" }> {
  if (probeAmount <= 0n) {
    throw new Error("probeAmount must be > 0.");
  }
  const encoded = toBytes32(probeAmount);

  for (let i = 0; i < MAX_ERC20_BALANCE_SLOTS; i++) {
    const base = BigInt(i);
    for (const layout of ["solidity", "vyper"] as const) {
      const slot =
        layout === "solidity"
          ? solidityMappingSlot(account, base)
          : vyperMappingSlot(account, base);
      const override: StateOverride = {
        [token]: { stateDiff: { [slot]: encoded } },
      };
      try {
        const bal = await readErc20Balance(provider, token, account, override);
        if (bal === probeAmount) {
          return { slot, layout };
        }
      } catch {
        // Token / RPC rejected this override shape; try next slot.
      }
    }
  }

  throw new Error(
    `Could not locate ERC-20 balance storage slot for ${token} (probed ${MAX_ERC20_BALANCE_SLOTS} base slots, solidity+vyper layouts).`
  );
}

function buildStateOverride(opts: {
  account: `0x${string}`;
  accountCode: string;
  /** Native ETH on the simulating account (unshield proceeds and/or gas stipend). */
  nativeBalanceWei: bigint;
  erc20?: {
    token: `0x${string}`;
    amount: bigint;
    balanceSlot: `0x${string}`;
  };
}): StateOverride {
  const override: StateOverride = {
    [opts.account]: {
      balance: toHexQuantity(opts.nativeBalanceWei),
      code: opts.accountCode,
    },
  };
  if (opts.erc20) {
    override[opts.erc20.token] = {
      stateDiff: {
        [opts.erc20.balanceSlot]: toBytes32(opts.erc20.amount),
      },
    };
  }
  return override;
}

/**
 * Estimate execution-phase gas for Tornado paymaster `tailCalls` by simulating
 * the EIP-7702 account's `execute` / `executeBatch` with RPC state overrides:
 *
 * - Inject the unshielded asset (native ETH balance, or ERC-20 via storage slot)
 * - When the asset is ERC-20, also leave a small ETH stipend on the account so
 *   `from=account` eth_estimateGas can pay for the simulated call
 * - Overlay Simple7702 implementation code (as after EIP-7702 delegation)
 *
 * Requires an RPC that supports `eth_estimateGas` / `eth_call` state overrides.
 */
export async function estimateTornadoTailCallsGas(opts: {
  rpcUrl: string;
  /** EIP-7702 batch delegator / UserOp sender (receives the unshield). */
  account: `0x${string}`;
  calls: readonly TornadoTailCall[];
  /**
   * Native ETH to place on `account` before the batch.
   * For ETH unshields: post-fee proceeds. For ERC-20 unshields: gas stipend only.
   */
  nativeBalanceWei: bigint;
  /** When set, also write this ERC-20 balance onto `account` via stateDiff. */
  erc20?: {
    token: `0x${string}`;
    amount: bigint;
  };
}): Promise<bigint> {
  if (opts.calls.length === 0) {
    throw new Error("Cannot estimate gas for an empty tail-call list.");
  }
  if (opts.nativeBalanceWei < 0n) {
    throw new Error("nativeBalanceWei must be >= 0.");
  }
  if (opts.erc20 && opts.erc20.amount < 0n) {
    throw new Error("erc20.amount must be >= 0.");
  }

  const client = await makePublicClient(opts.rpcUrl);
  try {
    const code = (await client.request({
      method: "eth_getCode",
      params: [TORNADO_SIMPLE_7702_IMPLEMENTATION, "latest"],
    })) as string;
    if (!code || code === "0x") {
      throw new Error(
        `Tornado Simple7702 implementation has no code at ${TORNADO_SIMPLE_7702_IMPLEMENTATION} on this RPC.`
      );
    }

    let erc20Override:
      | { token: `0x${string}`; amount: bigint; balanceSlot: `0x${string}` }
      | undefined;
    if (opts.erc20 && opts.erc20.amount > 0n) {
      const { slot } = await findErc20BalanceStorageSlot(
        client,
        opts.erc20.token,
        opts.account
      );
      erc20Override = {
        token: opts.erc20.token,
        amount: opts.erc20.amount,
        balanceSlot: slot,
      };
    }

    const data = encodeAccountCalls(opts.calls);
    const stateOverride = buildStateOverride({
      account: opts.account,
      accountCode: code,
      nativeBalanceWei: opts.nativeBalanceWei,
      erc20: erc20Override,
    });

    let gasHex: string;
    try {
      gasHex = (await client.request({
        method: "eth_estimateGas",
        params: [
          {
            from: opts.account,
            to: opts.account,
            data,
          },
          "latest",
          stateOverride,
        ] as never,
      })) as string;
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      throw new Error(
        `Failed to estimate Tornado tail-call gas via eth_estimateGas state overrides. ` +
          `Your RPC must support Geth-style state overrides on eth_estimateGas` +
          (opts.erc20 ? " (including ERC-20 stateDiff)." : ".") +
          `\n${detail}`,
        { cause: cause instanceof Error ? cause : undefined }
      );
    }

    const gas = BigInt(gasHex);
    if (gas <= 0n) {
      throw new Error(`eth_estimateGas returned non-positive gas (${gasHex}).`);
    }
    return gas;
  } finally {
    disposePublicClient(client);
  }
}

function buildSimulationPlan(opts: {
  recipient: `0x${string}`;
  amountWei: bigint;
  /** Paymaster fee already in unshield-asset units (wei or token). */
  estimatedFee: bigint;
  userTailCalls: readonly TornadoTailCall[];
  asset: TornadoTailFundAsset;
  /** Prepend leftover `token.transfer(recipient)` (external / stealth `--to`). */
  bakeErc20Forward?: boolean;
}): {
  calls: TornadoTailCall[];
  nativeBalanceWei: bigint;
  erc20?: { token: `0x${string}`; amount: bigint };
} {
  const afterFee = opts.amountWei - opts.estimatedFee;
  if (afterFee <= 0n) {
    throw new Error(
      `Withdrawal amount is too small to cover the Tornado paymaster fee (estimated ${opts.estimatedFee.toString()} base units).`
    );
  }

  if (opts.asset.kind === "erc20") {
    const userTailValue = opts.userTailCalls.reduce(
      (sum, call) => sum + call.value,
      0n
    );
    if (userTailValue > 0n) {
      throw new Error(
        "Tornado --tail-calls cannot include msg.value when unshielding an ERC-20: the 7702 account does not receive native ETH."
      );
    }
    const leftover = opts.bakeErc20Forward
      ? encodeTornadoErc20TransferTailCall(
          opts.asset.token,
          opts.recipient,
          afterFee
        )
      : undefined;
    return {
      calls: leftover ? [leftover, ...opts.userTailCalls] : [...opts.userTailCalls],
      nativeBalanceWei: TORNADO_TAIL_SIM_GAS_STIPEND_WEI,
      erc20: { token: opts.asset.token, amount: afterFee },
    };
  }

  const userTailValue = opts.userTailCalls.reduce(
    (sum, call) => sum + call.value,
    0n
  );
  if (userTailValue > afterFee) {
    throw new Error(
      `--tail-calls msg.value total (${userTailValue.toString()} wei) exceeds the amount remaining after the Tornado paymaster fee (${afterFee.toString()} wei).`
    );
  }
  const forwardValue = afterFee - userTailValue;
  const calls: TornadoTailCall[] = [
    ...(forwardValue > 0n
      ? [{ to: opts.recipient, data: "0x" as const, value: forwardValue }]
      : []),
    ...opts.userTailCalls,
  ];
  return { calls, nativeBalanceWei: afterFee };
}

/**
 * Resolve `tailCallsGasEstimate` for the SDK: simulate the forwarding + user
 * tail batch with injected post-unshield funds (ETH and/or ERC-20), refine
 * against the fee that depends on that estimate, then apply **10% overhead**.
 *
 * Returns `undefined` when there are no user-supplied tail calls (SDK uses its
 * static forward-only baseline).
 */
export async function resolveTornadoTailCallsGasEstimate(opts: {
  rpcUrl: string;
  account: `0x${string}`;
  amountWei: bigint;
  maxFeePerGas: bigint;
  extraWithdrawals: number;
  userTailCalls: readonly TornadoTailCall[];
  /** Unshielded asset that lands on `account` before tail calls run. */
  asset?: TornadoTailFundAsset;
  /**
   * Convert padded fee wei into unshield-asset units. ETH: omit (identity).
   * ERC-20: paymaster `quoteWeiInToken`.
   */
  feeWeiToAsset?: (feeWei: bigint) => Promise<bigint>;
  /**
   * When the asset is ERC-20 and leftover must be sent to `--to` (not already
   * on the 7702 delegator), simulate the baked `transfer` as well.
   */
  bakeErc20Forward?: boolean;
  /** Recipient of leftover ERC-20 transfer; defaults to `account`. */
  leftoverRecipient?: `0x${string}`;
}): Promise<bigint | undefined> {
  if (opts.userTailCalls.length === 0) return undefined;

  const asset: TornadoTailFundAsset = opts.asset ?? { kind: "native" };
  const isERC20 = asset.kind === "erc20";
  if (isERC20 && !opts.feeWeiToAsset) {
    throw new Error(
      "ERC-20 Tornado tail-call gas estimate requires feeWeiToAsset (quoteWeiInToken)."
    );
  }

  let executionTail = tornadoWithdrawalCallGasLimit(0, undefined, isERC20);
  let measured = 0n;

  for (let i = 0; i < MAX_REFINE_ITERS; i++) {
    const callGasLimit = tornadoWithdrawalCallGasLimit(
      opts.extraWithdrawals,
      executionTail,
      isERC20
    );
    const feeWei = estimateTornadoPaymasterFee(opts.maxFeePerGas, {
      callGasLimit,
      isERC20,
    });
    const feeReserveWei = padTornadoTailForwardFee(feeWei);
    const estimatedFee = opts.feeWeiToAsset
      ? await opts.feeWeiToAsset(feeReserveWei)
      : feeReserveWei;
    const plan = buildSimulationPlan({
      recipient: opts.leftoverRecipient ?? opts.account,
      amountWei: opts.amountWei,
      estimatedFee,
      userTailCalls: opts.userTailCalls,
      asset,
      bakeErc20Forward: isERC20 && !!opts.bakeErc20Forward,
    });
    measured = await estimateTornadoTailCallsGas({
      rpcUrl: opts.rpcUrl,
      account: opts.account,
      calls: plan.calls,
      nativeBalanceWei: plan.nativeBalanceWei,
      erc20: plan.erc20,
    });
    // Feed the buffered value into the next fee/forward refine iteration.
    executionTail = withTailCallsGasOverhead(measured);
  }

  return withTailCallsGasOverhead(measured);
}
