import {
  OxBowAspService,
  PrivacyPoolsV1_0xBow,
  createPPv1Plugin,
} from "@kohaku-eth/privacy-pools";
import {
  Bundler,
  Signer,
  SimpleSmartAccount,
  chainConfig,
  createRailgunPlugin,
  type LogLevel,
} from "@kohaku-eth/railgun";
import type { AssetAmount, Host } from "@kohaku-eth/plugins";
import {
  DepositStrategy,
  TornadoCashConfigs,
  TornadoPaymasterConfigs,
  createTCBroadcaster,
  createTCPlugin,
} from "@kohaku-eth/tornado-cash";
import { RailgunEthereumProviderAdapter } from "./railgun-provider-adapter";
import { createTornadoPaymasterBroadcaster } from "./tornado-paymaster-broadcaster";
import { railgunPimlicoBundlerUrl } from "./rpc";
import type { PluginId } from "../host/storage";
import ppv1SepoliaState from "./ppv1-sepolia-state.json";
import ppv1MainnetState from "./ppv1-mainnet-state.json";
import tcSepoliaState from "./tc-sepolia-state.json";

const OXBOW_ASP_URL_SEPOLIA = "https://dw.0xbow.io";
const OXBOW_ASP_URL_MAINNET = "https://api.0xbow.io";

function envTruthy(value: string | undefined): boolean {
  if (!value) return false;
  const v = value.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/** Shared options for `createRailgunPlugin` (session + direct protocol runtime). */
export function railgunPluginOptions(): {
  rpcBatchSize: number;
  logLevel?: LogLevel;
} {
  const opts: { rpcBatchSize: number; logLevel?: LogLevel } = { rpcBatchSize: 450 };
  if (envTruthy(process.env.KOHAKU_RAILGUN_DEBUG)) {
    opts.logLevel = "Debug";
  }
  return opts;
}

function oxbowAspUrlForChain(chainId: bigint): string {
  return chainId === 11155111n ? OXBOW_ASP_URL_SEPOLIA : OXBOW_ASP_URL_MAINNET;
}

export type SupportedProtocol = "railgun" | "privacy-pools" | "tornado";

export const ALL_PRIVATE_PROTOCOLS: readonly SupportedProtocol[] = [
  "railgun",
  "privacy-pools",
  "tornado",
];

/** True when `value` is a valid CLI `--protocol` (see {@link pluginIdForProtocol}). */
export function isSupportedProtocol(value: unknown): value is SupportedProtocol {
  return value === "railgun" || value === "privacy-pools" || value === "tornado";
}

/**
 * Parses `--include railgun,tornado`. Returns `null` when omitted (all protocols).
 */
export function parseIncludeProtocols(
  raw: string | undefined
): SupportedProtocol[] | null {
  if (!raw?.trim()) return null;

  const parts = raw.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
  const out: SupportedProtocol[] = [];
  const seen = new Set<SupportedProtocol>();

  for (const part of parts) {
    if (!isSupportedProtocol(part)) {
      throw new Error(
        `Invalid protocol in --include: ${part}. Use: ${SUPPORTED_PROTOCOLS_HELP}`
      );
    }
    if (seen.has(part)) continue;
    seen.add(part);
    out.push(part);
  }

  if (out.length === 0) {
    throw new Error(
      `--include requires at least one protocol. Use: ${SUPPORTED_PROTOCOLS_HELP}`
    );
  }

  return out;
}

export function shouldIncludeProtocol(
  protocol: SupportedProtocol,
  includeProtocols: SupportedProtocol[] | null
): boolean {
  return includeProtocols === null || includeProtocols.includes(protocol);
}

export const SUPPORTED_PROTOCOLS_HELP = "railgun | privacy-pools | tornado";

/**
 * Maps CLI `--protocol` to {@link PluginId} for Host (storage paths + keystore flavor).
 *
 * | `--protocol`    | pluginId | Notes                          |
 * |-----------------|----------|--------------------------------|
 * | `railgun`       | `rg`     | Railgun keystore, rg-storage   |
 * | `privacy-pools` | `ppv1`   | Default keystore, ppv1-storage |
 * | `tornado`       | `tc`     | Default keystore, tc-storage   |
 */
export function pluginIdForProtocol(protocol: SupportedProtocol): PluginId {
  if (protocol === "railgun") return "rg";
  if (protocol === "tornado") return "tc";
  return "ppv1";
}

/** Smallest ETH pool denomination (deposits must be multiples of this). */
export const TORNADO_ETH_MIN_DENOMINATION_WEI: Record<string, bigint> = {
  "1": 100000000000000000n,
  "11155111": 100000000000000000n,
};

export function assertTornadoEthOnly(isEth: boolean): void {
  if (!isEth) {
    throw new Error("Tornado Cash in kohaku-cli currently supports ETH only.");
  }
}

export function assertTornadoShieldAmount(chainId: bigint, amount: bigint): void {
  const min = TORNADO_ETH_MIN_DENOMINATION_WEI[chainId.toString()];
  if (!min) {
    throw new Error(`Tornado Cash is not configured for chainId ${chainId.toString()}.`);
  }
  if (amount <= 0n || amount % min !== 0n) {
    throw new Error(
      "Tornado shield amount must be a positive multiple of 0.1 ETH (fixed pool denominations)."
    );
  }
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
  prepareShield(asset: AssetAmount, ...args: unknown[]): Promise<unknown>;
  prepareUnshield?(
    asset: AssetAmount,
    recipient: `0x${string}`,
    ...args: unknown[]
  ): Promise<unknown>;
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
  setSmartAccount: (smartAccount: SimpleSmartAccount, signer: Signer) => void;
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

/** Railgun unshield: 4337 bundler + recipient EOA as EIP-7702 smart account signer. */
export function configureRailgunForUnshield(
  plugin: unknown,
  host: Host,
  chainId: bigint,
  recipientPrivateKey: `0x${string}`,
  bundlerUrl: string
): void {
  const rg = plugin as RailgunUnshieldConfigurable;
  const signer = Signer.privateKey(recipientPrivateKey);
  const eip1193 = new RailgunEthereumProviderAdapter(host.provider);
  const smartAccount = new SimpleSmartAccount(signer.address, chainId, eip1193);
  rg.setBundler(Bundler.pimlico(bundlerUrl));
  rg.setSmartAccount(smartAccount, signer);
}

export function tornadoHasBundledInitialState(chainId: bigint): boolean {
  return chainId === 11155111n;
}

/** ERC-4337 paymaster settings for Tornado unshield (same Pimlico bundler as Railgun). */
export function tornadoPaymasterConfig(
  chainId: bigint
): Record<number, unknown> | undefined {
  const staticCfg =
    TornadoPaymasterConfigs[Number(chainId) as keyof typeof TornadoPaymasterConfigs];
  if (!staticCfg) return undefined;
  return {
    [Number(chainId)]: {
      ...staticCfg,
      bundlerUrl: railgunPimlicoBundlerUrl(chainId),
    },
  };
}

export function assertTornadoPaymasterConfigured(chainId: bigint): void {
  if (!tornadoPaymasterConfig(chainId)) {
    throw new Error(
      `Tornado Cash ERC-4337 paymaster is not configured for chainId ${chainId.toString()}.`
    );
  }
}

/** Tornado unshield via Pimlico bundler + on-chain paymaster (not ENS relayers). */
export function tornadoUnshieldOptions(): { mode: "paymaster" } {
  return { mode: "paymaster" };
}

export async function prepareProtocolShield(
  plugin: AnyPlugin,
  protocol: SupportedProtocol,
  asset: AssetAmount
): Promise<unknown> {
  if (protocol === "tornado") {
    return plugin.prepareShield(asset, {
      strategy: DepositStrategy.MaxAnonimitySet,
    });
  }
  return plugin.prepareShield(asset);
}

function ppv1BundledSnapshotMap(chainId: bigint): Record<string, unknown> {
  return (chainId === 11155111n ? ppv1SepoliaState : ppv1MainnetState) as Record<
    string,
    unknown
  >;
}

function ppv1StorageKey(chainId: bigint, entrypointAddress: bigint): string {
  return `privacy-pool-state-${chainId.toString()}-${entrypointAddress.toString()}`;
}

function ppv1LastSyncedBlock(state: unknown): bigint {
  const raw = (state as { sync?: { lastSyncedBlock?: string | number } })?.sync
    ?.lastSyncedBlock;
  if (raw == null) return 0n;
  return typeof raw === "string" ? BigInt(raw) : BigInt(raw);
}

/**
 * Privacy Pools only uses bundled JSON when wallet storage has no entry for this
 * chain/entrypoint. Seed (or upgrade stale) ppv1-storage so first sync resumes from
 * the snapshot instead of deployment block.
 */
async function ensurePpv1BundledStateSeeded(
  host: Host,
  chainId: bigint,
  entrypointAddress: bigint
): Promise<void> {
  const storageKey = ppv1StorageKey(chainId, entrypointAddress);
  const bundled = ppv1BundledSnapshotMap(chainId)[storageKey];
  if (!bundled) return;

  const bundledBlock = ppv1LastSyncedBlock(bundled);
  const existingRaw = await host.storage.get(storageKey);
  if (!existingRaw) {
    await host.storage.set(storageKey, JSON.stringify(bundled));
    return;
  }

  try {
    const existing = JSON.parse(existingRaw) as unknown;
    if (ppv1LastSyncedBlock(existing) < bundledBlock) {
      await host.storage.set(storageKey, JSON.stringify(bundled));
    }
  } catch {
    await host.storage.set(storageKey, JSON.stringify(bundled));
  }
}

export async function createProtocolPlugin(
  protocol: SupportedProtocol,
  host: Host,
  chainId: bigint
): Promise<AnyPlugin> {
  if (protocol === "railgun") {
    return createRailgunPlugin(host, railgunPluginOptions());
  }

  if (protocol === "tornado") {
    const config = TornadoCashConfigs[Number(chainId) as 1 | 11155111];
    if (!config) {
      throw new Error(
        `No Tornado Cash deployment config for chainId ${chainId.toString()}`
      );
    }
    const paymasterConfig = tornadoPaymasterConfig(chainId);
    return createTCPlugin(host, {
      accountIndex: 0,
      protocolConfig: config,
      ...(paymasterConfig ? { paymasterConfig: paymasterConfig as never } : {}),
      ...(chainId === 11155111n
        ? { initialState: async () => tcSepoliaState as never }
        : {}),
    });
  }

  const params = PrivacyPoolsV1_0xBow[Number(chainId) as 1 | 11155111];
  if (!params) {
    throw new Error(`No Privacy Pools deployment config for chainId ${chainId.toString()}`);
  }

  const entrypointAddress = BigInt(params.entrypoint.entrypointAddress);

  await ensurePpv1BundledStateSeeded(host, chainId, entrypointAddress);

  const ppv1Params = {
    accountIndex: 0,
    entrypoint: {
      address: entrypointAddress,
      deploymentBlock: params.entrypoint.deploymentBlock,
    },
    broadcasterUrl: PRIVACY_POOLS_BROADCASTER_URL,
    aspServiceFactory: () =>
      new OxBowAspService({
        network: host.network,
        aspUrl: oxbowAspUrlForChain(chainId),
      }),
    initialState:
      chainId === 11155111n
        ? async () => ppv1SepoliaState as never
        : async () => ppv1MainnetState as never,
  };

  return createPPv1Plugin(host, ppv1Params);
}

export async function broadcastTornadoPrivateOp(
  host: Host,
  operation: unknown,
  chainId: bigint
): Promise<unknown> {
  const paymasterConfig = tornadoPaymasterConfig(chainId);
  const broadcaster = createTCBroadcaster(host, {
    ...(paymasterConfig
      ? {
          paymasterConfig: paymasterConfig as never,
          paymasterClientFactory: () =>
            createTornadoPaymasterBroadcaster(
              host,
              paymasterConfig as never
            ) as never,
        }
      : {}),
  });
  return await broadcaster.broadcast(operation as never);
}
