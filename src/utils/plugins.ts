import {
  OxBowAspService,
  PrivacyPoolsV1_0xBow,
  createPPv1Plugin,
} from "@kohaku-eth/privacy-pools";
import { createRailgunPlugin } from "@kohaku-eth/railgun";
import type { AssetAmount, Host } from "@kohaku-eth/plugins";

import ppv1SepoliaState from "./ppv1-sepolia-state.json"

const OXBOW_ASP_URL = "https://dw.0xbow.io";

export type SupportedProtocol = "railgun" | "privacy-pools";

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

export async function createProtocolPlugin(
  protocol: SupportedProtocol,
  host: Host,
  chainId: bigint
): Promise<AnyPlugin> {
  if (protocol === "railgun") {
    return createRailgunPlugin(host, 0);
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
    aspServiceFactory: () =>
      new OxBowAspService({
        network: host.network,
        aspUrl: OXBOW_ASP_URL,
      }),
    ...(chainId === 11155111n
      ? { initialState: ppv1SepoliaState as never }
      : {}),
  };

  return createPPv1Plugin(host, ppv1Params);
}
