import {
  estimateTornadoTailCallsGas,
  TORNADO_TAIL_SIM_GAS_STIPEND_WEI,
  withTailCallsGasOverhead,
  type TornadoTailCall,
} from "./tornado-tail-gas.js";

export type RailgunTailCall = TornadoTailCall;

export type RailgunTailFundAsset =
  | { kind: "native" }
  | { kind: "erc20"; token: `0x${string}` };

/**
 * Estimate Railgun *user* `tailCalls` gas via eth_estimateGas + state overrides.
 *
 * Why not estimate bare tails alone? They spend the unshielded funds that only
 * exist after the privacy-paymaster lands value on the AA. We inject those
 * post-unshield balances (native ETH after conceptual WETH.unwrap, or ERC-20)
 * onto the EIP-7702 account and simulate `execute` / `executeBatch` — same
 * technique as Tornado.
 *
 * Broadcast still relies on the Railgun SDK estimating the **whole** UserOp
 * (bundler sees WETH.withdraw prefix + user tails). This CLI estimate is for
 * fee preview / `--amount-max` headroom only; UnshieldOptions has no gas field.
 *
 * Returns `undefined` when there are no user tails.
 */
export async function resolveRailgunTailCallsGasEstimate(opts: {
  rpcUrl: string;
  /** Smart-account / unshield `to` (EIP-7702 sender). */
  account: `0x${string}`;
  /** Receivable unshield amount that lands on `account` before user tails. */
  amountWei: bigint;
  userTailCalls: readonly RailgunTailCall[];
  asset: RailgunTailFundAsset;
}): Promise<bigint | undefined> {
  if (opts.userTailCalls.length === 0) return undefined;
  if (opts.amountWei <= 0n) {
    throw new Error(
      "Cannot estimate Railgun tail-call gas: unshield amount must be > 0."
    );
  }

  const userTailValue = opts.userTailCalls.reduce(
    (sum, call) => sum + call.value,
    0n
  );

  let nativeBalanceWei: bigint;
  let erc20: { token: `0x${string}`; amount: bigint } | undefined;

  if (opts.asset.kind === "native") {
    if (userTailValue > opts.amountWei) {
      throw new Error(
        `--tail-calls msg.value total (${userTailValue.toString()} wei) exceeds the unshield amount (${opts.amountWei.toString()} wei).`
      );
    }
    // Post WETH.withdraw: AA holds the unshielded ETH. Static unwrap gas is
    // counted separately in estimateRailgunBundlerFeeWei.
    nativeBalanceWei = opts.amountWei;
  } else {
    // ERC-20 lands on the AA; stipend pays eth_estimateGas from=account.
    nativeBalanceWei = TORNADO_TAIL_SIM_GAS_STIPEND_WEI;
    erc20 = { token: opts.asset.token, amount: opts.amountWei };
  }

  const measured = await estimateTornadoTailCallsGas({
    rpcUrl: opts.rpcUrl,
    account: opts.account,
    calls: opts.userTailCalls,
    nativeBalanceWei,
    erc20,
  });

  return withTailCallsGasOverhead(measured);
}

export function railgunTailFundAsset(tokenMeta: {
  isEth: boolean;
  tokenAddress: string;
}): RailgunTailFundAsset {
  if (tokenMeta.isEth) return { kind: "native" };
  return {
    kind: "erc20",
    token: tokenMeta.tokenAddress as `0x${string}`,
  };
}
