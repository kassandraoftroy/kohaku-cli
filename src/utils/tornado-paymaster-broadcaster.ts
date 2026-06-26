import type { Host } from "@kohaku-eth/plugins";
import { BundlerClient, TornadoBuilder } from "@privacy-paymasters/sdk";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Hash, Hex, SignedAuthorization } from "viem";

/** Extra call gas on top of @kohaku-eth/tornado-cash manual paymaster estimates. */
export const TORNADO_PAYMASTER_CALL_GAS_BUMP = 100_000n;

const ERC20_TRANSFER_GAS = 100_000n;

/** Matches tornado-cash `baseGasUnits.callGasLimit` before CLI bump. */
const TORNADO_BASE_CALL_GAS_LIMIT = 300_000n;

const TORNADO_BASE_GAS_UNITS = {
  preVerificationGas: 80_000n,
  verificationGasLimit: 50_000n,
  paymasterVerificationGasLimit: 350_000n,
  paymasterPostOpGasLimit: 10_000n,
} as const;

function tornadoPaymasterManualGas(isERC20: boolean) {
  const callGasLimit =
    TORNADO_BASE_CALL_GAS_LIMIT +
    TORNADO_PAYMASTER_CALL_GAS_BUMP +
    (isERC20 ? ERC20_TRANSFER_GAS : 0n);
  return { ...TORNADO_BASE_GAS_UNITS, callGasLimit };
}

type PaymasterConfigByChain = Record<
  number,
  {
    entryPointAddress: Hex;
    paymasterAddress: Hex;
    poolsAccountsMap: Record<Hex, Hex>;
    bundlerUrl: string;
  }
>;

type PaymasterWithdrawal = {
  proof: {
    proof: Hex;
    args: [Hex, Hex, Hex, Hex, Hex, Hex];
  };
  poolAddress: bigint;
  isERC20: boolean;
  paymasterAddress: Hex;
  entryPointAddress: Hex;
  bundlerUrl: string;
  accountAddress?: Hex;
  delegation?: {
    senderAddress: Hex;
    authorization: SignedAuthorization<number>;
  };
};

async function signDelegationAuthorization(opts: {
  privateKey: Hex;
  accountAddress: Hex;
  chainId: number;
  nonce: number;
}): Promise<{ senderAddress: Hex; authorization: SignedAuthorization<number> }> {
  const account = privateKeyToAccount(opts.privateKey);
  const authorization = await account.signAuthorization({
    contractAddress: opts.accountAddress,
    chainId: opts.chainId,
    nonce: opts.nonce,
  });
  return { authorization, senderAddress: account.address };
}

async function broadcastOne(
  withdrawal: PaymasterWithdrawal,
  provider: Host["provider"]
): Promise<{ userOpHash: Hash }> {
  const {
    proof: { proof: proofHex, args: proofArgs },
    paymasterAddress,
    entryPointAddress,
    bundlerUrl,
    accountAddress,
    isERC20,
  } = withdrawal;
  if (!accountAddress) {
    throw new Error("Tornado paymaster withdrawal missing pool smart account address.");
  }

  const [root, nullifierHash, recipient, relayerInProof, feeHex] = proofArgs;
  if (BigInt(paymasterAddress) !== BigInt(relayerInProof)) {
    throw new Error(
      `relayer must be paymaster when using the 4337 paymaster flow: ${paymasterAddress} != ${relayerInProof}`
    );
  }

  const delegation =
    withdrawal.delegation ??
    (await signDelegationAuthorization({
      privateKey: generatePrivateKey(),
      accountAddress,
      chainId: Number(await provider.getChainId()),
      nonce: 0,
    }));
  const { senderAddress, authorization } = delegation;

  const bundlerClient = new BundlerClient(bundlerUrl, entryPointAddress);
  const {
    standard: { maxFeePerGas, maxPriorityFeePerGas },
  } = await bundlerClient.getUserOperationGasPrice();

  const gas = {
    type: "manual" as const,
    ...tornadoPaymasterManualGas(isERC20),
    maxFeePerGas,
    maxPriorityFeePerGas,
  };

  const op = await new TornadoBuilder(senderAddress)
    .withPaymaster(paymasterAddress)
    .withAuthorization(authorization)
    .withWithdraw(
      proofHex,
      root,
      nullifierHash,
      recipient,
      relayerInProof,
      BigInt(feeHex)
    )
    .withGas(gas)
    .build(provider, bundlerClient);

  const userOpHash = await bundlerClient.sendUserOperation(op);
  await bundlerClient.waitForUserOperationReceipt(userOpHash);
  return { userOpHash };
}

/** Paymaster broadcaster with bumped manual gas for Tornado 4337 unshield. */
export function createTornadoPaymasterBroadcaster(
  host: Host,
  paymasterConfig: PaymasterConfigByChain
) {
  return {
    async broadcast(withdrawals: unknown[]) {
      const chainId = Number(await host.provider.getChainId());
      const chainCfg = paymasterConfig[chainId];
      if (!chainCfg) {
        throw new Error(`No Tornado paymaster config for chainId ${chainId}.`);
      }

      const poolAccountsMap = new Map(
        Object.entries(chainCfg.poolsAccountsMap).map(([poolAccount, tornadoAccount]) => [
          BigInt(poolAccount),
          tornadoAccount as Hex,
        ])
      );

      const results = await Promise.allSettled(
        (withdrawals as PaymasterWithdrawal[]).map((w) =>
          broadcastOne(
            {
              ...w,
              accountAddress: poolAccountsMap.get(w.poolAddress),
            },
            host.provider
          )
        )
      );

      const failed = results.filter((r) => r.status === "rejected");
      if (failed.length > 0) {
        console.warn(
          "Some Tornado paymaster withdrawals failed.",
          failed.map((r) => (r as PromiseRejectedResult).reason).join("\n")
        );
      }

      return results
        .filter((r): r is PromiseFulfilledResult<{ userOpHash: Hash }> => r.status === "fulfilled")
        .map((r) => r.value);
    },
  };
}
