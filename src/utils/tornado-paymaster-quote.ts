import { parseAbi } from "viem";
import { TornadoPaymasterConfigs } from "@kohaku-eth/tornado-cash";

import { formatCaughtError } from "./cli-errors.js";
import { disposePublicClient, makePublicClient } from "./rpc.js";

const QUOTE_WEI_IN_TOKEN_ABI = parseAbi([
  "function quoteWeiInToken(address feeToken, uint256 weiAmount) view returns (uint256 tokenAmount)",
]);

export function tornadoPaymasterAddress(chainId: bigint): `0x${string}` {
  const cfg =
    TornadoPaymasterConfigs[Number(chainId) as keyof typeof TornadoPaymasterConfigs];
  const address = cfg?.paymasterAddress;
  if (!address) {
    throw new Error(
      `Tornado Cash ERC-4337 paymaster is not configured for chainId ${chainId.toString()}.`
    );
  }
  return address as `0x${string}`;
}

/**
 * On-chain paymaster TWAP: how much of `feeToken` covers `feeWei` of gas.
 * Same `quoteWeiInToken` the UserOp validation uses — not a CLI price feed.
 */
export async function quoteTornadoPaymasterFeeInToken(opts: {
  rpcUrl: string;
  chainId: bigint;
  feeToken: `0x${string}`;
  feeWei: bigint;
}): Promise<bigint> {
  if (opts.feeWei < 0n) {
    throw new Error("feeWei must be >= 0.");
  }
  if (opts.feeWei === 0n) return 0n;

  const paymaster = tornadoPaymasterAddress(opts.chainId);
  const client = await makePublicClient(opts.rpcUrl);
  try {
    return await client.readContract({
      address: paymaster,
      abi: QUOTE_WEI_IN_TOKEN_ABI,
      functionName: "quoteWeiInToken",
      args: [opts.feeToken, opts.feeWei],
    });
  } catch (e) {
    throw new Error(
      `Tornado paymaster quoteWeiInToken failed for ${opts.feeToken} ` +
        `(${opts.feeWei.toString()} wei) at ${paymaster}: ${formatCaughtError(e)}`
    );
  } finally {
    disposePublicClient(client);
  }
}
