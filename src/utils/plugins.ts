import {
  OxBowAspService,
  PrivacyPoolsV1_0xBow,
  createPPv1Plugin,
} from "@kohaku-eth/privacy-pools";
import { Bundler, Signer, chainConfig, createRailgunPlugin } from "@kohaku-eth/railgun";
import type { AssetAmount, Host } from "@kohaku-eth/plugins";
import { ethers } from "ethers";
import type { PluginId } from "../host/storage";
import ppv1SepoliaState from "./ppv1-sepolia-state.json";
import ppv1MainnetState from "./ppv1-mainnet-state.json";

const OXBOW_ASP_URL = "https://dw.0xbow.io";

export type SupportedProtocol = "railgun" | "privacy-pools";

/** True when `value` is a valid CLI `--protocol` (see {@link pluginIdForProtocol}). */
export function isSupportedProtocol(value: unknown): value is SupportedProtocol {
  return value === "railgun" || value === "privacy-pools";
}

/**
 * Maps CLI `--protocol` to {@link PluginId} for Host (storage paths + keystore flavor).
 *
 * | `--protocol`    | pluginId | Notes                          |
 * |-----------------|----------|--------------------------------|
 * | `railgun`       | `rg`     | Railgun keystore, rg-storage   |
 * | `privacy-pools` | `ppv1`   | Default keystore, ppv1-storage |
 */
export function pluginIdForProtocol(protocol: SupportedProtocol): PluginId {
  return protocol === "railgun" ? "rg" : "ppv1";
}

/** Throws if the ERC-20 is not on the Privacy Pools whitelist for this chain (non-ETH tokens only). */
export function assertPpErc20TokenWhitelisted(
  chainId: bigint,
  tokenAddress: string
): void {
  const wl =
    PRIVACY_POOLS_TOKEN_WHITELIST[chainId.toString()] ?? new Set<string>();
  if (!wl.has(tokenAddress.toLowerCase())) {
    throw new Error(
      `Token ${tokenAddress} is not whitelisted for privacy-pools on chain ${chainId.toString()}.`
    );
  }
}

export type AnyPlugin = {
  balance(assets: Array<unknown> | undefined): Promise<Array<AssetAmount>>;
  prepareShield(asset: AssetAmount): Promise<unknown>;
  sync?: () => Promise<void>;
};

export const ETH_AS_ERC20 = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

export const PRIVACY_POOLS_TOKEN_WHITELIST: Record<string, Set<string>> = {
  "1": new Set<string>(),
  "11155111": new Set<string>(),
};

export const PRIVACY_POOLS_BROADCASTER_URL = "https://fastrelay.xyz/relayer";

type RailgunUnshieldConfigurable = {
  setBundler: (bundler?: Bundler) => void;
  setDelegatingSigner: (signer?: Signer) => void;
};

/**
 * Railgun ETH unshield: `native` for unwrap semantics; `contract` is WETH so
 * SignerPool.drain can match shielded balance (railgun passes `tokens` to drain).
 */
export function railgunNativeEthAssetAmount(
  chainId: bigint,
  amount: bigint
): AssetAmount {
  const chain = chainConfig(chainId);
  if (!chain) {
    throw new Error(
      `Railgun is not supported on chainId ${chainId.toString()}.`
    );
  }
  return {
    asset: {
      __type: "native",
      contract: chain.wrappedBaseToken,
    } as AssetAmount["asset"],
    amount,
  };
}

/** Railgun unshield: 4337 bundler + recipient EOA as EIP-7702 delegating signer. */
export function configureRailgunForUnshield(
  plugin: unknown,
  recipientPrivateKey: `0x${string}`,
  bundlerUrl: string
): void {
  const rg = plugin as RailgunUnshieldConfigurable;
  rg.setBundler(Bundler.pimlico(bundlerUrl));
  console.log("recipientPrivateKey:", recipientPrivateKey);
  console.log("recipientAddress:", ethers.computeAddress(recipientPrivateKey));
  rg.setDelegatingSigner(Signer.privateKey(recipientPrivateKey));
}

export async function createProtocolPlugin(
  protocol: SupportedProtocol,
  host: Host,
  chainId: bigint
): Promise<AnyPlugin> {
  if (protocol === "railgun") {
    return createRailgunPlugin(host, { rpcBatchSize: 450 });
  }

  const params = PrivacyPoolsV1_0xBow[Number(chainId) as 1 | 11155111];
  if (!params) {
    throw new Error(`No Privacy Pools deployment config for chainId ${chainId.toString()}`);
  }

  const ppv1Params = {
    accountIndex: 0,
    entrypoint: {
      address: BigInt(params.entrypoint.entrypointAddress),
      deploymentBlock: params.entrypoint.deploymentBlock,
    },
    broadcasterUrl: PRIVACY_POOLS_BROADCASTER_URL,
    ...(chainId === 11155111n
      ? {
          aspServiceFactory: () =>
            new OxBowAspService({
              network: host.network,
              aspUrl: OXBOW_ASP_URL,
            }),
          initialState: ppv1SepoliaState as never,
        }
      : { initialState: ppv1MainnetState as never }),
  };

  return createPPv1Plugin(host, ppv1Params);
}
