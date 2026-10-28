import {
  OxBowAspService,
  PrivacyPoolsV1_0xBow,
  SecretManager as PrivacyPoolsSecretManager,
  SignatureSecretManager as PrivacyPoolsSignatureSecretManager,
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
import type { AssetAmount, Host, UnshieldOptions } from "@kohaku-eth/plugins";
import {
  DepositStrategy,
  SecretManager as TornadoSecretManager,
  SignatureSecretManager as TornadoSignatureSecretManager,
  TornadoCashConfigs,
  TornadoPaymasterConfigs,
  createTCBroadcaster,
  createTCPlugin,
  type ISecretManager as TornadoISecretManager,
  type SecretManagerParams as TornadoSecretManagerParams,
  type TCPaymasterUnshieldOptions,
  type TCNote,
} from "@kohaku-eth/tornado-cash";
import {
  prefixStorage,
  SIGNATURE_STORAGE_PREFIX,
  type NoteDerivation,
} from "./derivation-scheme.js";
import {
  estimateTornadoPaymasterFee,
  padTornadoTailForwardFee,
  tornadoWithdrawalCallGasLimit,
} from "./tornado-paymaster-gas.js";
import { tornadoDelegationConfig } from "./tornado-unshield-delegation.js";
import { createTorAwarePaymasterBroadcaster } from "./tornado-paymaster-broadcaster.js";
import {
  encodeTornadoErc20TransferTailCall,
  type TornadoTailCall,
} from "./tornado-tail-gas.js";
import { RailgunEthereumProviderAdapter } from "./railgun-provider-adapter";
import { makeTornadoArtifactsLoader } from "./proving-artifacts.js";
import { privacyPoolsPaymasterConfig } from "./privacy-pools-paymaster.js";
import {
  createPrivacyPoolsSagaDataService,
  privacyPoolsSagaSourceUrl,
} from "./privacy-pools-saga.js";
import { railgunPimlicoBundlerUrl } from "./rpc";
import type { PluginId } from "../host/storage";
import ppv1SepoliaState from "./ppv1-sepolia-state.json";

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
 * Reads `DEFAULT_PRIVACY_PROTOCOL` when it is one of
 * {@link ALL_PRIVATE_PROTOCOLS}; otherwise returns `undefined`.
 */
export function resolveDefaultPrivacyProtocol(): SupportedProtocol | undefined {
  const raw = process.env.DEFAULT_PRIVACY_PROTOCOL?.trim();
  if (!raw) return undefined;
  return isSupportedProtocol(raw) ? raw : undefined;
}

export type ResolveProtocolResult =
  | { ok: true; protocol: SupportedProtocol }
  | { ok: false; error: "invalid" | "missing" };

/**
 * Resolves `--protocol` for shield/unshield: flag wins, else
 * {@link resolveDefaultPrivacyProtocol}.
 */
export function resolveProtocolOption(
  flag: string | undefined
): ResolveProtocolResult {
  const trimmed = flag?.trim();
  if (trimmed) {
    if (isSupportedProtocol(trimmed)) return { ok: true, protocol: trimmed };
    return { ok: false, error: "invalid" };
  }
  const def = resolveDefaultPrivacyProtocol();
  if (def) return { ok: true, protocol: def };
  return { ok: false, error: "missing" };
}

function parseProtocolList(
  raw: string | undefined,
  flag: "--include" | "--protocol"
): SupportedProtocol[] | null {
  if (!raw?.trim()) return null;

  const parts = raw.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
  const out: SupportedProtocol[] = [];
  const seen = new Set<SupportedProtocol>();

  for (const part of parts) {
    if (!isSupportedProtocol(part)) {
      throw new Error(
        `Invalid protocol in ${flag}: ${part}. Use: ${SUPPORTED_PROTOCOLS_HELP}`
      );
    }
    if (seen.has(part)) continue;
    seen.add(part);
    out.push(part);
  }

  if (out.length === 0) {
    throw new Error(
      `${flag} requires at least one protocol. Use: ${SUPPORTED_PROTOCOLS_HELP}`
    );
  }

  return out;
}

/**
 * Parses `--include railgun,tornado`. Returns `null` when omitted
 * (caller may apply env / empty defaults).
 */
export function parseIncludeProtocols(
  raw: string | undefined
): SupportedProtocol[] | null {
  return parseProtocolList(raw, "--include");
}

/**
 * Resolves which private protocols `balances` should sync:
 * - explicit `--include` → those protocols
 * - else `DEFAULT_PRIVACY_PROTOCOL` when set → that one protocol
 * - else → none (`[]`)
 */
export function resolveIncludeProtocols(
  raw: string | undefined
): SupportedProtocol[] {
  const parsed = parseIncludeProtocols(raw);
  if (parsed) return parsed;
  const def = resolveDefaultPrivacyProtocol();
  return def ? [def] : [];
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

/** Smallest ETH pool denomination (shield amounts must be multiples of this). */
export const TORNADO_ETH_MIN_DENOMINATION_WEI: Record<string, bigint> = {
  "1": 100000000000000000n,
  "11155111": 100000000000000000n,
};

/** Fixed ETH pool denominations (wei) per chain. */
export const TORNADO_ETH_DENOMINATIONS_WEI: Record<string, readonly bigint[]> = {
  "1": [
    100000000000000000n, // 0.1
    1000000000000000000n, // 1
    10000000000000000000n, // 10
    100000000000000000000n, // 100
  ],
  "11155111": [
    100000000000000000n, // 0.1
    1000000000000000000n, // 1
  ],
};

export function assertTornadoEthOnly(isEth: boolean): void {
  if (!isEth) {
    throw new Error("Tornado Cash in kohaku-cli currently supports ETH only.");
  }
}

/**
 * @deprecated Prefer {@link assertTornadoDepositAmount} from tornado-pools
 * (saga-backed, supports ERC-20). Kept for ETH-only call sites mid-migration.
 */
export function assertTornadoShieldAmount(chainId: bigint, amount: bigint): void {
  const min = TORNADO_ETH_MIN_DENOMINATION_WEI[chainId.toString()];
  if (!min) {
    throw new Error(`Tornado Cash is not configured for chainId ${chainId.toString()}.`);
  }
  if (amount <= 0n || amount % min !== 0n) {
    throw new Error(
      "Tornado shield amount must be a positive exact multiple of 0.1 ETH (e.g. 0.1, 1.3). Amounts like 1.35 ETH are not depositable."
    );
  }
}

export function assertTornadoUnshieldAmount(
  chainId: bigint,
  amount: bigint
): void {
  assertTornadoShieldAmount(chainId, amount);
}

/** Use saga CDN when a pool is at least this many blocks behind head. */
export const TORNADO_MIN_EXTERNAL_SYNC_BLOCKS = 1_000;

export type AnyPlugin = {
  balance(assets: Array<unknown> | undefined): Promise<Array<AssetAmount>>;
  prepareShield(asset: AssetAmount, ...args: unknown[]): Promise<unknown>;
  prepareUnshield?(
    asset: AssetAmount,
    recipient: `0x${string}`,
    ...args: unknown[]
  ): Promise<unknown>;
  sync?: () => Promise<void>;
  notes?: (...args: unknown[]) => Promise<unknown[]>;
  /** Tornado Cash: register legacy note strings that match synced deposits. */
  importNotes?: (notes: string | string[]) => Promise<unknown[]>;
};

export const ETH_AS_ERC20 = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

/**
 * Still required by `createPPv1Plugin`. Unshields do not quote or broadcast
 * through this relayer; they use the ERC-4337 paymaster.
 */
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

/**
 * Railgun ERC-20 spend: lowercase `contract` so SignerPool.drain matches WASM
 * note keys (checksummed CLI addresses otherwise look like zero balance).
 */
export function railgunErc20AssetAmount(
  tokenAddress: string,
  amount: bigint
): AssetAmount {
  return {
    asset: {
      __type: "erc20",
      contract: tokenAddress.toLowerCase() as `0x${string}`,
    },
    amount,
  };
}

/**
 * Asset passed to `prepareUnshield`. Railgun uses native/WETH; Privacy Pools
 * and Tornado use the ERC-20 shape (ETH as the `0xeee…` sentinel).
 */
export function privateUnshieldAsset(
  protocol: SupportedProtocol,
  chainId: bigint,
  tokenMeta: { isEth: boolean; tokenAddress: string },
  amount: bigint
): AssetAmount {
  if (protocol === "railgun") {
    return tokenMeta.isEth
      ? railgunNativeEthAssetAmount(chainId, amount)
      : railgunErc20AssetAmount(tokenMeta.tokenAddress, amount);
  }
  return {
    asset: {
      __type: "erc20",
      contract: (tokenMeta.isEth
        ? ETH_AS_ERC20
        : tokenMeta.tokenAddress) as `0x${string}`,
    },
    amount,
  };
}

/**
 * Railgun can send ERC-20s to an address this wallet does not control: funds
 * land at `to` via the privacy paymaster. Native ETH unwraps WETH on the 7702
 * account, and user `--tail-calls` also execute there, so those need a wallet key.
 */
export function assertRailgunExternalRecipientAllowed(opts: {
  isEth: boolean;
  hasTailCalls: boolean;
}): void {
  if (!opts.isEth && !opts.hasTailCalls) return;
  if (opts.hasTailCalls) {
    throw new Error(
      "Railgun --tail-calls run on the recipient EIP-7702 account, so the recipient must be a public or stealth account from this wallet."
    );
  }
  throw new Error(
    "Railgun native ETH unshield unwraps WETH on the recipient account, so the recipient must be a public or stealth account from this wallet (use --next, a stored address, or a custom address this wallet controls)."
  );
}

/**
 * Railgun unshield: 4337 bundler + EIP-7702 UserOp signer.
 * Wallet-owned recipient: pass that account's key (funds land on the AA).
 * External ERC-20 `to`: pass any wallet-owned key; tokens still land at `to`.
 */
export function configureRailgunForUnshield(
  plugin: unknown,
  host: Host,
  chainId: bigint,
  smartAccountPrivateKey: `0x${string}`,
  bundlerUrl: string
): void {
  const rg = plugin as RailgunUnshieldConfigurable;
  const signer = Signer.privateKey(smartAccountPrivateKey);
  const eip1193 = new RailgunEthereumProviderAdapter(host.provider);
  const smartAccount = new SimpleSmartAccount(signer.address, chainId, eip1193);
  rg.setBundler(Bundler.pimlico(bundlerUrl));
  rg.setSmartAccount(smartAccount, signer);
}

/** ERC-4337 paymaster settings for Tornado unshield (same Pimlico bundler as Railgun). */
export function tornadoPaymasterConfig(
  chainId: bigint
): Record<number, unknown> | undefined {
  const staticCfg = TornadoPaymasterConfigs[Number(chainId) as keyof typeof TornadoPaymasterConfigs];
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

export type UnshieldTailCall = TornadoTailCall;

/**
 * Railgun unshield execution-phase tails. Unlike Tornado, do **not** bake a
 * leftover-forward ETH transfer — unshielded funds already land at `to` via the
 * privacy paymaster. Native unshield still prefixes `WETH.withdraw` in the SDK.
 */
export function railgunUnshieldOptions(
  tailCalls: readonly UnshieldTailCall[] = []
): UnshieldOptions | undefined {
  if (tailCalls.length === 0) return undefined;
  return {
    tailCalls: async () => [...tailCalls],
  };
}

export type TornadoErc20TailForward = {
  token: `0x${string}`;
  /** Padded paymaster fee already quoted in token base units. */
  feeReserveToken: bigint;
  /**
   * Prepend leftover `token.transfer(recipient)`. False when recipient is the
   * 7702 delegator (`--next` / HD `--to`) — tokens already sit on the account.
   */
  bakeForward: boolean;
};

/** Tornado unshield via Pimlico bundler + on-chain paymaster (not ENS relayers). */
export function tornadoUnshieldOptions(
  recipient: `0x${string}`,
  amountWei: bigint,
  maxFeePerGas: bigint,
  /**
   * BIP-32 path for a wallet-controlled batch 7702 (`--next` / stored HD `--to`
   * / stored stealth via `STEALTH_ADDRESS_MAGIC_VALUE_PATH`). Omit only for a
   * single-note unshield with no `--tail-calls` (the SDK uses a recoverable
   * note-derived sender and forwards the proceeds to `recipient`).
   */
  delegationPath: string | undefined,
  withdrawalCount: number,
  tailCalls: readonly UnshieldTailCall[] = [],
  /** Measured execution-tail gas for user `tailCalls` (SDK `tailCallsGasEstimate`). */
  tailCallsGasEstimate?: bigint,
  /** When set, unshield asset is an ERC-20 (fee already quoted in token units). */
  erc20?: TornadoErc20TailForward,
  /**
   * Prepend a leftover transfer to `recipient` (ETH value, or ERC-20 when
   * `erc20.bakeForward`). Default true. Private transfer sets this false so
   * the only outgoing call is the exact payment and the remainder stays on
   * the 7702 account.
   */
  forwardLeftover = true
): TCPaymasterUnshieldOptions {
  const delegation = tornadoDelegationConfig({
    delegationPath,
    tailCallsCount: tailCalls.length,
    withdrawalCount,
  });

  const base: TCPaymasterUnshieldOptions = {
    mode: "paymaster",
    gasEstimationPolicy: tailCalls.length > 0 ? "required" : "best-effort",
    ...(delegation ? { delegation } : {}),
  };

  // No user tails: omit `tailCalls` so the SDK forwards leftovers with the
  // *actual* proof fee (`forwardCalls(fee)`). Baking our own forward here was
  // the Sepolia ExecuteError(1) failure mode (pre-estimate fee < proof fee).
  if (tailCalls.length === 0) {
    return base;
  }

  const isERC20 = erc20 != null;
  if (isERC20) {
    const userTailValue = tailCalls.reduce((sum, call) => sum + call.value, 0n);
    if (userTailValue > 0n) {
      throw new Error(
        "Tornado --tail-calls cannot include msg.value when unshielding an ERC-20: the 7702 account does not receive native ETH."
      );
    }
    const afterFee = amountWei - erc20.feeReserveToken;
    if (afterFee <= 0n) {
      throw new Error(
        `Withdrawal amount is too small to cover the Tornado paymaster fee (estimated ${erc20.feeReserveToken.toString()} token base units).`
      );
    }
    const bakeForward = forwardLeftover && erc20.bakeForward && afterFee > 0n;
    return {
      ...base,
      ...(tailCallsGasEstimate !== undefined ? { tailCallsGasEstimate } : {}),
      tailCalls: async () => [
        ...(bakeForward
          ? [
              encodeTornadoErc20TransferTailCall(
                erc20.token,
                recipient,
                afterFee
              ),
            ]
          : []),
        ...tailCalls,
      ],
    };
  }

  const extraWithdrawals = Math.max(0, withdrawalCount - 1);
  const feeCallGasLimit = tornadoWithdrawalCallGasLimit(
    extraWithdrawals,
    tailCallsGasEstimate,
    false
  );
  const estimatedFee = estimateTornadoPaymasterFee(maxFeePerGas, {
    callGasLimit: feeCallGasLimit,
    isERC20: false,
  });
  const feeReserve = padTornadoTailForwardFee(estimatedFee);
  const afterFee = amountWei - feeReserve;
  if (afterFee <= 0n) {
    throw new Error(
      `Withdrawal amount is too small to cover the Tornado paymaster fee (estimated ${feeReserve.toString()} wei).`
    );
  }
  const userTailValue = tailCalls.reduce((sum, call) => sum + call.value, 0n);
  if (userTailValue > afterFee) {
    throw new Error(
      `--tail-calls msg.value total (${userTailValue.toString()} wei) exceeds the amount remaining after the Tornado paymaster fee (${afterFee.toString()} wei).`
    );
  }
  const forwardValue = forwardLeftover ? afterFee - userTailValue : 0n;

  return {
    ...base,
    // Passed through to SDK prepareUnshield → paymasterWithdrawThunk as
    // `tailCallsGasEstimate` (initial budget; successful estimation is required).
    ...(tailCallsGasEstimate !== undefined ? { tailCallsGasEstimate } : {}),
    tailCalls: async () => [
      ...(forwardValue > 0n
        ? [{ to: recipient, data: "0x" as const, value: forwardValue }]
        : []),
      ...tailCalls,
    ],
  };
}

/** Unspent Tornado notes for an asset (balance > 0). */
export async function listTornadoUnspentNotes(
  plugin: AnyPlugin,
  asset: AssetAmount["asset"]
): Promise<TCNote[]> {
  if (!plugin.notes) {
    throw new Error("Tornado plugin does not expose notes.");
  }
  const notes = (await plugin.notes([asset], false)) as TCNote[];
  return notes.filter((n) => n.balance > 0n);
}

/** Sum of all unspent Tornado note denominations (0 when none). */
export async function totalTornadoUnspentBalance(
  plugin: AnyPlugin,
  asset: AssetAmount["asset"]
): Promise<bigint> {
  let sum = 0n;
  for (const note of await listTornadoUnspentNotes(plugin, asset)) {
    sum += note.amount;
  }
  return sum;
}

/** Notes cannot sum to a Tornado unshield that covers `target`. */
export class TornadoCoverError extends Error {
  readonly target: bigint;
  readonly covered: bigint;

  constructor(target: bigint, covered: bigint) {
    super(
      `Insufficient Tornado balance to cover ${target.toString()} (notes cover ${covered.toString()}).`
    );
    this.name = "TornadoCoverError";
    this.target = target;
    this.covered = covered;
  }
}

/**
 * How many notes the Tornado SDK's largest-first packer spends to withdraw
 * `amount` exactly. Throws when the notes cannot compose that amount.
 */
export function tornadoWithdrawalCountForAmount(
  noteAmounts: readonly bigint[],
  amount: bigint
): number {
  const notesByDenom = new Map<bigint, number>();
  for (const noteAmount of noteAmounts) {
    if (noteAmount <= 0n) continue;
    notesByDenom.set(noteAmount, (notesByDenom.get(noteAmount) ?? 0) + 1);
  }
  const denominations = [...notesByDenom.keys()].sort((a, b) =>
    a > b ? -1 : a < b ? 1 : 0
  );

  let amountToWithdraw = 0n;
  let count = 0;
  for (const denom of denominations) {
    if (amountToWithdraw + denom > amount) continue;
    let remaining = notesByDenom.get(denom)!;
    while (remaining > 0 && amountToWithdraw + denom <= amount) {
      count++;
      amountToWithdraw += denom;
      remaining--;
    }
  }
  if (amountToWithdraw < amount) {
    throw new Error(
      `Insufficient Tornado balance to unshield ${amount.toString()} wei (notes cover ${amountToWithdraw.toString()} wei).`
    );
  }
  return count;
}

/** True when this scheme's notes can compose `amount` exactly. */
export function tornadoSchemeCanCover(
  noteAmounts: readonly bigint[],
  amount: bigint
): boolean {
  if (amount <= 0n) return false;
  try {
    tornadoWithdrawalCountForAmount(noteAmounts, amount);
    return true;
  } catch {
    return false;
  }
}

/**
 * Smallest note sum `>= target` that `tornadoWithdrawalCountForAmount` can
 * withdraw exactly. Ties on sum keep the combination the largest-first packer
 * will actually spend (fewer large notes).
 */
export function minimumTornadoNoteSumCovering(
  noteAmounts: readonly bigint[],
  target: bigint
): bigint {
  if (target <= 0n) {
    throw new Error("Tornado cover target must be greater than zero.");
  }
  const counts = new Map<bigint, number>();
  let total = 0n;
  for (const noteAmount of noteAmounts) {
    if (noteAmount <= 0n) continue;
    counts.set(noteAmount, (counts.get(noteAmount) ?? 0) + 1);
    total += noteAmount;
  }
  if (total < target) {
    throw new TornadoCoverError(target, total);
  }

  let reachable = new Map<bigint, number>([[0n, 0]]);
  for (const denom of counts.keys()) {
    const count = counts.get(denom)!;
    const next = new Map(reachable);
    for (const [sum, notes] of reachable) {
      for (let k = 1; k <= count; k++) {
        const added = sum + denom * BigInt(k);
        const used = notes + k;
        const prev = next.get(added);
        if (prev === undefined || used < prev) next.set(added, used);
      }
    }
    reachable = next;
  }

  const candidates = [...reachable.keys()]
    .filter((sum) => sum >= target)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const sum of candidates) {
    try {
      tornadoWithdrawalCountForAmount(noteAmounts, sum);
      return sum;
    } catch {
      continue;
    }
  }
  throw new TornadoCoverError(target, total);
}

/**
 * Number of Tornado notes consumed for this unshield amount (one paymaster UserOp).
 */
export async function countTornadoWithdrawals(
  plugin: AnyPlugin,
  asset: AssetAmount,
  amount: bigint
): Promise<number> {
  const notes = await listTornadoUnspentNotes(plugin, asset.asset);
  return tornadoWithdrawalCountForAmount(
    notes.map((note) => note.amount),
    amount
  );
}

export async function prepareProtocolShield(
  plugin: AnyPlugin,
  protocol: SupportedProtocol,
  asset: AssetAmount
): Promise<unknown> {
  if (protocol === "tornado") {
    return plugin.prepareShield(asset, {
      // Prefer larger denominations first (fewer deposits / aggregated approvals).
      strategy: DepositStrategy.MinFee,
    });
  }
  return plugin.prepareShield(asset);
}

function ppv1BundledSnapshotMap(chainId: bigint): Record<string, unknown> {
  if (chainId !== 11155111n) return {};
  return ppv1SepoliaState as Record<string, unknown>;
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
 * Sepolia has no saga stream, so seed its bundled snapshot when wallet storage
 * is missing or older. Mainnet history comes from the saga CDN instead.
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

/**
 * Commitment that is not a real pool leaf. A scheme-scoped Tornado scan treats
 * it as a miss and does not record the other scheme's notes.
 */
const UNMATCHED_TORNADO_SECRET = {
  nullifier: 1n,
  salt: 1n,
  commitment: 1n,
  nullifierHash: 1n,
} as Awaited<ReturnType<TornadoISecretManager["getLegacyDepositSecrets"]>>;

/**
 * Tornado's default manager discovers both schemes in one state. This CLI keeps
 * them in separate stores: each factory keeps `deriveDelegatorSigner` (keystore
 * path, including the stealth sentinel) and stubs only the other scheme's scan.
 */
async function tornadoSchemeSecretManager(
  scheme: NoteDerivation,
  params: TornadoSecretManagerParams
): Promise<TornadoISecretManager> {
  const legacy = await TornadoSecretManager(params);
  const signature = await TornadoSignatureSecretManager(params);
  const combined: TornadoISecretManager = { ...legacy, ...signature };
  if (scheme === "legacy") {
    return {
      ...combined,
      getSignatureSecrets: async () => UNMATCHED_TORNADO_SECRET,
    };
  }
  return {
    ...combined,
    getLegacyDepositSecrets: async () => UNMATCHED_TORNADO_SECRET,
  };
}

function hostForScheme(host: Host, scheme: NoteDerivation): Host {
  if (scheme === "legacy") return host;
  return {
    ...host,
    storage: prefixStorage(host.storage, SIGNATURE_STORAGE_PREFIX),
  };
}

export type SchemedPlugins = {
  /** BIP-32 notes and imported Tornado note strings. Existing storage keys. */
  legacy: AnyPlugin;
  /** Signature-derived notes. New shields use this plugin. */
  signature: AnyPlugin;
};

/**
 * One plugin per derivation. Railgun has no scheme split, so both fields are
 * the same instance. Tornado and Privacy Pools use separate storage keys and
 * secret managers; sync them one after the other.
 */
export async function createSchemedPlugins(
  protocol: SupportedProtocol,
  host: Host,
  chainId: bigint,
  excludeNewPools = false
): Promise<SchemedPlugins> {
  if (protocol === "railgun") {
    const plugin = await createProtocolPlugin(protocol, host, chainId, "legacy");
    return { legacy: plugin, signature: plugin };
  }
  const legacy = await createProtocolPlugin(protocol, host, chainId, "legacy", excludeNewPools);
  const signature = await createProtocolPlugin(
    protocol,
    hostForScheme(host, "signature"),
    chainId,
    "signature",
    excludeNewPools
  );
  return { legacy, signature };
}

export async function createProtocolPlugin(
  protocol: SupportedProtocol,
  host: Host,
  chainId: bigint,
  scheme: NoteDerivation = "legacy",
  excludeNewPools = false
): Promise<AnyPlugin> {
  if (protocol === "railgun") {
    return (await createRailgunPlugin(
      host,
      railgunPluginOptions()
    )) as AnyPlugin;
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
      useExtendedEthPools: !excludeNewPools,
      minExternalSyncBlocksAmount: TORNADO_MIN_EXTERNAL_SYNC_BLOCKS,
      artifactsLoader: makeTornadoArtifactsLoader(),
      secretManagerFactory: (params) => tornadoSchemeSecretManager(scheme, params),
      ...(paymasterConfig ? { paymasterConfig: paymasterConfig as never } : {}),
    }) as AnyPlugin;
  }

  const params = PrivacyPoolsV1_0xBow[Number(chainId) as 1 | 11155111];
  if (!params) {
    throw new Error(`No Privacy Pools deployment config for chainId ${chainId.toString()}`);
  }

  const entrypointAddress = BigInt(params.entrypoint.entrypointAddress);

  await ensurePpv1BundledStateSeeded(host, chainId, entrypointAddress);

  const paymasterConfig = privacyPoolsPaymasterConfig(chainId);
  const ppv1Params = {
    accountIndex: 0,
    entrypoint: {
      address: entrypointAddress,
      deploymentBlock: params.entrypoint.deploymentBlock,
    },
    broadcasterUrl: PRIVACY_POOLS_BROADCASTER_URL,
    ...(paymasterConfig ? { paymasterConfig: paymasterConfig as never } : {}),
    aspServiceFactory: () =>
      new OxBowAspService({
        network: host.network,
        aspUrl: oxbowAspUrlForChain(chainId),
      }),
    ...(chainId === 11155111n
      ? { initialState: async () => ppv1SepoliaState as never }
      : {}),
  };

  // Sepolia's saga index does not publish Privacy Pools, so that chain keeps
  // the default eth_getLogs sync. Mainnet reads history from the saga CDN and
  // only the blocks past saga's head from RPC.
  const dataService = privacyPoolsSagaSourceUrl(chainId)
    ? createPrivacyPoolsSagaDataService({
        provider: host.provider,
        chainId,
      })
    : undefined;

  // Each plugin scans only its own scheme. The SDK default is signature
  // secrets; legacy deposits stay spendable on the BIP-32 manager.
  return createPPv1Plugin(host, {
    ...ppv1Params,
    secretManager:
      scheme === "legacy"
        ? PrivacyPoolsSecretManager
        : PrivacyPoolsSignatureSecretManager,
    ...(dataService ? { dataService } : {}),
  } as never) as AnyPlugin;
}

export async function broadcastTornadoPrivateOp(
  host: Host,
  operation: unknown,
  chainId: bigint
): Promise<unknown> {
  const paymasterConfig = tornadoPaymasterConfig(chainId);
  const broadcaster = createTCBroadcaster(host, {
    ...(paymasterConfig
      ? { paymasterConfig: paymasterConfig as never }
      : {}),
    // Viem's default 10s HTTP timeout + retries double-submits over Tor
    // (Pimlico "Already known"). Use a Tor-aware client instead.
    paymasterClientFactory: () =>
      createTorAwarePaymasterBroadcaster(chainId) as never,
  });

  return await broadcaster.broadcast(operation as never);
}
