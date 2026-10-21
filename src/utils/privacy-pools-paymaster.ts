/**
 * Privacy Pools ERC-4337 paymaster wiring and unshield fee math.
 *
 * Adapter addresses mirror `@kohaku-eth/privacy-pools` `PrivacyPoolsPaymasterConfigs`
 * (not a public export). `bundlerUrl` is replaced with the Tor-aware Pimlico URL.
 * Gas units mirror `reasonableGasUnits` / `reasonableGasUnitsForBatch` in that package:
 * the SDK's `estimateUnshield` ignores extra notes, so multi-note gross is sized here.
 */
import { PrivacyPoolsV1_0xBow } from "@kohaku-eth/privacy-pools";
import { formatUnits, getAddress, parseAbi, zeroAddress } from "viem";

import type { TornadoTailCall } from "./tornado-tail-gas.js";
import { disposePublicClient, makePublicClient, railgunPimlicoBundlerUrl } from "./rpc.js";

/** Same sentinel plugins use for native ETH inside ERC-20-shaped private assets. */
const ETH_AS_ERC20 = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

export type UnshieldTailCall = TornadoTailCall;

const ZERO_PAYMASTER = zeroAddress;

/** Baseline UserOp gas from privacy-pools `paymaster/fee.ts`. */
export const PP_PAYMASTER_GAS = {
  preVerificationGas: 100_000n,
  verificationGasLimit: 50_000n,
  paymasterVerificationGasLimit: 1_200_000n,
  paymasterPostOpGasLimit: 50_000n,
  erc20TransferGas: 100_000n,
  perExtraWithdraw: 500_000n,
  perExtraWithdrawErc20: 600_000n,
  forwardGas: 80_000n,
  tailCallsDefaultGas: 300_000n,
} as const;

type PaymasterChainConfig = {
  entryPointAddress: `0x${string}`;
  paymasterAddress: `0x${string}`;
  poolsAccountsMap: Record<string, `0x${string}`>;
};

/**
 * Mainnet adapters from privacy-pools 0.0.2-alpha.24. Sepolia's paymaster is
 * still the zero address with an empty pool map, so unshield is unavailable.
 */
const PAYMASTER_CHAINS: Record<number, PaymasterChainConfig> = {
  1: {
    entryPointAddress: "0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108",
    paymasterAddress: "0xe06CB96C57D2442f8F60F5017354BC08F7e91308",
    poolsAccountsMap: {
      "0xf241d57c6debae225c0f2e6ea1529373c9a9c9fb":
        "0x521F578Ac6E894939364Dc27c7e6978Ecf7b7926",
      "0xe859c0bd25f260baee534fb52e307d3b64d24572":
        "0x3B33c5cb645690E6b7Df599F58CADA8fA189C36F",
      "0xb419c2867ab3cbc78921660cb95150d95a94ce86":
        "0x841E8F12FDbB2c55c9E054B4c6d07c2743E09cFC",
    },
  },
  11155111: {
    entryPointAddress: "0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108",
    paymasterAddress: ZERO_PAYMASTER,
    poolsAccountsMap: {},
  },
};

export type PrivacyPoolsPaymasterConfig = PaymasterChainConfig & {
  bundlerUrl: string;
};

export function privacyPoolsPaymasterConfig(
  chainId: bigint
): Record<number, PrivacyPoolsPaymasterConfig> | undefined {
  const staticCfg = PAYMASTER_CHAINS[Number(chainId)];
  if (!staticCfg) return undefined;
  return {
    [Number(chainId)]: {
      ...staticCfg,
      bundlerUrl: railgunPimlicoBundlerUrl(chainId),
    },
  };
}

export function privacyPoolsPaymasterForChain(
  chainId: bigint
): PrivacyPoolsPaymasterConfig | undefined {
  const cfg = privacyPoolsPaymasterConfig(chainId)?.[Number(chainId)];
  if (!cfg) return undefined;
  if (cfg.paymasterAddress.toLowerCase() === ZERO_PAYMASTER) return undefined;
  if (Object.keys(cfg.poolsAccountsMap).length === 0) return undefined;
  return cfg;
}

export function assertPrivacyPoolsPaymasterConfigured(chainId: bigint): PrivacyPoolsPaymasterConfig {
  const cfg = privacyPoolsPaymasterForChain(chainId);
  if (!cfg) {
    if (chainId === 11155111n) {
      throw new Error(
        "privacy pools unshields do not currently work on sepolia testnet (no paymaster contract)"
      );
    }
    throw new Error(
      `Privacy Pools ERC-4337 paymaster is not configured for chainId ${chainId.toString()}.`
    );
  }
  return cfg;
}

export function privacyPoolsAdapterForPool(
  chainId: bigint,
  poolAddress: string
): `0x${string}` | undefined {
  const cfg = privacyPoolsPaymasterForChain(chainId);
  if (!cfg) return undefined;
  return cfg.poolsAccountsMap[poolAddress.toLowerCase()];
}

const ASSET_CONFIG_ABI = parseAbi([
  "function assetConfig(address _asset) view returns (address pool, uint256 minimumDepositAmount, uint256 vettingFeeBPS, uint256 maxRelayFeeBPS)",
]);

const QUOTE_WEI_IN_TOKEN_ABI = parseAbi([
  "function quoteWeiInToken(address feeToken, uint256 weiAmount) view returns (uint256 tokenAmount)",
]);

export type PrivacyPoolsAssetConfig = {
  pool: `0x${string}`;
  minimumDeposit: bigint;
  vettingFeeBps: bigint;
};

export function privacyPoolsAssetAddress(isEth: boolean, tokenAddress: string): `0x${string}` {
  return (isEth ? ETH_AS_ERC20 : tokenAddress) as `0x${string}`;
}

export async function fetchPrivacyPoolsAssetConfig(
  rpcUrl: string,
  chainId: bigint,
  asset: `0x${string}`
): Promise<PrivacyPoolsAssetConfig> {
  const deployment = PrivacyPoolsV1_0xBow[Number(chainId) as 1 | 11155111];
  if (!deployment) {
    throw new Error(
      `No Privacy Pools deployment config for chainId ${chainId.toString()}.`
    );
  }
  const client = await makePublicClient(rpcUrl);
  try {
    const cfg = await client.readContract({
      address: deployment.entrypoint.entrypointAddress as `0x${string}`,
      abi: ASSET_CONFIG_ABI,
      functionName: "assetConfig",
      args: [asset],
    });
    return {
      pool: getAddress(cfg[0]),
      minimumDeposit: BigInt(cfg[1]),
      vettingFeeBps: BigInt(cfg[2]),
    };
  } finally {
    disposePublicClient(client);
  }
}

/** Unshield requires a paymaster adapter for this asset's pool. */
export async function assertPrivacyPoolsUnshieldSupported(
  rpcUrl: string,
  chainId: bigint,
  token: { isEth: boolean; tokenAddress: string; symbol: string }
): Promise<void> {
  assertPrivacyPoolsPaymasterConfigured(chainId);
  const asset = privacyPoolsAssetAddress(token.isEth, token.tokenAddress);
  const config = await fetchPrivacyPoolsAssetConfig(rpcUrl, chainId, asset);
  assertPrivacyPoolsPoolConfigured(config, chainId, token.symbol);
  if (!privacyPoolsAdapterForPool(chainId, config.pool)) {
    throw new Error(
      `Privacy Pools ERC-4337 unshield is not configured for ${token.symbol} on chain ${chainId.toString()}.`
    );
  }
}

export function assertPrivacyPoolsPoolConfigured(
  config: PrivacyPoolsAssetConfig,
  chainId: bigint,
  tokenLabel: string
): void {
  if (config.pool.toLowerCase() === ZERO_PAYMASTER) {
    throw new Error(
      `${tokenLabel} is not supported for privacy-pools on chain ${chainId.toString()} (no pool).`
    );
  }
}

export function privacyPoolsVettingFee(amount: bigint, vettingFeeBps: bigint): bigint {
  return (amount * vettingFeeBps) / 10_000n;
}

export function assertPrivacyPoolsMinimumDeposit(
  amount: bigint,
  minimumDeposit: bigint,
  decimals: number,
  symbol: string
): void {
  if (amount < minimumDeposit) {
    throw new Error(
      `Privacy Pools deposit must be at least ${formatUnits(minimumDeposit, decimals)} ${symbol}.`
    );
  }
}

export async function quotePrivacyPoolsPaymasterFeeInToken(opts: {
  rpcUrl: string;
  chainId: bigint;
  feeToken: `0x${string}`;
  feeWei: bigint;
}): Promise<bigint> {
  if (opts.feeWei === 0n) return 0n;
  const paymaster = assertPrivacyPoolsPaymasterConfigured(opts.chainId).paymasterAddress;
  const client = await makePublicClient(opts.rpcUrl);
  try {
    return await client.readContract({
      address: paymaster,
      abi: QUOTE_WEI_IN_TOKEN_ABI,
      functionName: "quoteWeiInToken",
      args: [opts.feeToken, opts.feeWei],
    });
  } finally {
    disposePublicClient(client);
  }
}

export type PpNoteBalance = {
  balance: bigint;
  approved?: boolean;
  assetAddress: bigint | string;
};

export function privacyPoolsNoteAssetKey(assetAddress: bigint | string): string {
  if (typeof assetAddress === "bigint") {
    return `0x${assetAddress.toString(16).padStart(40, "0")}`.toLowerCase();
  }
  return String(assetAddress).toLowerCase();
}

/** Approved notes for one asset, largest balance first. */
export function privacyPoolsApprovedNotes(
  notes: readonly PpNoteBalance[],
  asset: string
): PpNoteBalance[] {
  const key = asset.toLowerCase();
  return notes
    .filter(
      (n) =>
        n.approved === true &&
        n.balance > 0n &&
        privacyPoolsNoteAssetKey(n.assetAddress) === key
    )
    .sort((a, b) => (a.balance > b.balance ? -1 : a.balance < b.balance ? 1 : 0));
}

/**
 * How many approved notes cover `amount` (largest first, last note partial).
 * Throws when the approved balance is short.
 */
export function countPrivacyPoolsNotesForAmount(
  notesLargestFirst: readonly PpNoteBalance[],
  amount: bigint
): number {
  if (amount <= 0n) {
    throw new Error("Withdrawal amount must be greater than zero.");
  }
  let remaining = amount;
  let count = 0;
  for (const note of notesLargestFirst) {
    if (remaining <= 0n) break;
    const take = note.balance < remaining ? note.balance : remaining;
    count += 1;
    remaining -= take;
  }
  if (remaining > 0n) {
    const covered = amount - remaining;
    throw new Error(
      `Insufficient Privacy Pools balance to unshield ${amount.toString()} (approved notes cover ${covered.toString()}).`
    );
  }
  return count;
}

export function sumPrivacyPoolsNoteBalances(
  notesLargestFirst: readonly PpNoteBalance[]
): bigint {
  let sum = 0n;
  for (const note of notesLargestFirst) sum += note.balance;
  return sum;
}

/**
 * True when these notes can pay `net` plus the paymaster fee `feeFor` quotes
 * for the resulting extra withdrawals. Does not mix in notes from another list.
 */
export async function privacyPoolsSchemeCovers(opts: {
  notes: readonly PpNoteBalance[];
  net: bigint;
  feeFor: (extraWithdrawals: number) => Promise<bigint>;
}): Promise<boolean> {
  if (opts.net <= 0n) return false;
  if (sumPrivacyPoolsNoteBalances(opts.notes) < opts.net) return false;
  let extra = 0;
  let fee: bigint;
  try {
    fee = await opts.feeFor(0);
  } catch {
    return false;
  }
  for (let i = 0; i < 4; i++) {
    let count: number;
    try {
      count = countPrivacyPoolsNotesForAmount(opts.notes, opts.net + fee);
    } catch {
      return false;
    }
    const nextExtra = Math.max(0, count - 1);
    let nextFee: bigint;
    try {
      nextFee = await opts.feeFor(nextExtra);
    } catch {
      return false;
    }
    if (nextFee === fee && nextExtra === extra) return true;
    extra = nextExtra;
    fee = nextFee;
  }
  try {
    countPrivacyPoolsNotesForAmount(opts.notes, opts.net + fee);
    return true;
  } catch {
    return false;
  }
}

/**
 * Gas units the paymaster fee is priced against.
 * Single-note withdrawals with no user tails have `callGasLimit` 0 (payout
 * happens in validation). Extra notes and user tails add an execution phase.
 */
export function privacyPoolsRequiredGas(opts: {
  isErc20: boolean;
  extraWithdrawals: number;
  hasUserTailCalls: boolean;
  tailCallsGasEstimate?: bigint;
}): bigint {
  const paymasterVerification =
    PP_PAYMASTER_GAS.paymasterVerificationGasLimit +
    (opts.isErc20 ? PP_PAYMASTER_GAS.erc20TransferGas : 0n);
  let callGas = 0n;
  if (opts.extraWithdrawals > 0 || opts.hasUserTailCalls) {
    const perNote = opts.isErc20
      ? PP_PAYMASTER_GAS.perExtraWithdrawErc20
      : PP_PAYMASTER_GAS.perExtraWithdraw;
    const executionTail = opts.hasUserTailCalls
      ? (opts.tailCallsGasEstimate ?? PP_PAYMASTER_GAS.tailCallsDefaultGas)
      : PP_PAYMASTER_GAS.forwardGas;
    callGas = BigInt(Math.max(0, opts.extraWithdrawals)) * perNote + executionTail;
  }
  return (
    PP_PAYMASTER_GAS.verificationGasLimit +
    callGas +
    paymasterVerification +
    PP_PAYMASTER_GAS.preVerificationGas +
    PP_PAYMASTER_GAS.paymasterPostOpGasLimit
  );
}

/** Wei fee: required gas × maxFeePerGas × 1.2, matching the SDK. */
export function privacyPoolsFeeWei(requiredGas: bigint, maxFeePerGas: bigint): bigint {
  return (requiredGas * maxFeePerGas * 12n) / 10n;
}

/**
 * User `--tail-calls` run on the wallet `--to` account. That account is the
 * EIP-7702 delegator and already holds the withdrawal, so leftovers stay there.
 * Do not prepend a transfer to `--to`.
 */
export function privacyPoolsUserTailCalls(opts: {
  net: bigint;
  isEth: boolean;
  userTailCalls: readonly UnshieldTailCall[];
}): UnshieldTailCall[] {
  const tailValue = opts.userTailCalls.reduce((sum, call) => sum + call.value, 0n);
  if (!opts.isEth && tailValue > 0n) {
    throw new Error(
      "--tail-calls cannot include msg.value when unshielding an ERC-20."
    );
  }
  if (tailValue > opts.net) {
    throw new Error(
      `--tail-calls msg.value total (${tailValue.toString()} wei) exceeds the unshield amount (${opts.net.toString()} wei).`
    );
  }
  return [...opts.userTailCalls];
}

/**
 * Static execution-tail gas passed to the SDK when the user supplied tails.
 * No leftover-forward is baked, so this is the default tail budget plus a
 * per-call buffer. The SDK uses it in place of its own forward gas.
 */
export function privacyPoolsTailCallsGasEstimate(userTailCount: number): bigint {
  if (userTailCount <= 0) return 0n;
  return (
    PP_PAYMASTER_GAS.tailCallsDefaultGas +
    PP_PAYMASTER_GAS.forwardGas * BigInt(userTailCount)
  );
}
