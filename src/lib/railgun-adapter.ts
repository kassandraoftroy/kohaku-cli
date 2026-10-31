import { existsSync } from "node:fs";
import { join } from "node:path";
import type { AssetAmount, Host } from "@kohaku-eth/plugins";
import {
  RailgunWallet,
  buildShieldCalls,
  railgunKeyPaths,
  type Hex,
  type PoiProcessReport,
  type PreparedUserOperation,
  type RailgunBalance,
  type RailgunNote,
  type UnshieldOptions as RailgunUnshieldOptions,
} from "kohaku-rg-js-wrapper";

import { railgunHostContext } from "../host/railgun-host-context.js";
import { DEFAULT_ARTIFACTS_BASE_URL } from "../utils/proving-artifacts.js";
import { addSyncUnits, beginSyncActivity } from "../utils/sync-progress.js";

const CHECKPOINT_KEY = "railgun-rust-checkpoint";
const MIGRATION_COMPLETE_KEY = "railgun-rust-migration-complete";
const SYNC_WINDOW = 100_000n;
const warnedResync = new Set<string>();
const ERC20_ID = /^erc20:(0x[0-9a-fA-F]{40})$/;

function erc20Address(asset: string): Hex {
  const match = ERC20_ID.exec(asset);
  if (!match) throw new Error(`Railgun asset is not a supported ERC-20: ${asset}`);
  return match[1]!.toLowerCase() as Hex;
}

function assetAddress(asset: AssetAmount["asset"], wrappedBaseToken: Hex): Hex {
  const value = asset as { __type?: string; contract?: unknown };
  if (value.__type === "native") return wrappedBaseToken;
  if (value.__type === "erc20" && typeof value.contract === "string" &&
      /^0x[0-9a-fA-F]{40}$/.test(value.contract)) {
    return value.contract.toLowerCase() as Hex;
  }
  throw new Error("Railgun supports native ETH and ERC-20 assets only");
}

export function railgunUnshieldInput(
  asset: AssetAmount,
  recipient: Hex,
  calls: readonly { to: Hex; value: bigint; data: Hex }[],
  wrappedBaseToken: Hex,
  spend: { accountPrivateKey: Hex; bundlerUrl: string },
): RailgunUnshieldOptions {
  return {
    recipient,
    token: assetAddress(asset.asset, wrappedBaseToken),
    amount: BigInt(asset.amount),
    unwrapNative: (asset.asset as { __type?: string }).__type === "native",
    tailCalls: calls.map((call) => ({ target: call.to, value: call.value, data: call.data })),
    ...spend,
  };
}

export function railgunBalanceForCli(entry: RailgunBalance): AssetAmount {
  return {
    asset: { __type: "erc20", contract: erc20Address(entry.asset) },
    amount: entry.amount,
    tag: entry.poiStatus ?? "Unavailable",
  } as AssetAmount;
}

export function railgunNoteForCli(entry: RailgunNote): Record<string, unknown> {
  return {
    asset: { __type: "erc20", contract: erc20Address(entry.asset) },
    amount: entry.amount,
    balance: entry.amount,
    treeNumber: entry.treeNumber,
    leafIndex: entry.leafIndex,
    blindedCommitment: entry.blindedCommitment,
    commitmentType: entry.commitmentType,
    memo: entry.memo,
    poiStatus: entry.poiStatus ?? "Unavailable",
  };
}

async function chainHead(rpcUrl: string): Promise<bigint> {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
  });
  if (!response.ok) throw new Error(`Railgun RPC head request failed: HTTP ${response.status}`);
  const body = await response.json() as { result?: string; error?: { message?: string } };
  if (body.error) throw new Error(`Railgun RPC head request failed: ${body.error.message}`);
  if (!body.result) throw new Error("Railgun RPC did not return a block number");
  return BigInt(body.result);
}

type SyncableRailgunWallet = {
  readonly syncedBlock: bigint;
  readonly chain: { readonly deploymentBlock: bigint };
  syncTo(block: bigint): Promise<void>;
  sync(): Promise<void>;
};

/** Returns false when the indexer source has not yet reached the RPC head. */
export async function syncRailgunHistory(wallet: SyncableRailgunWallet, head: bigint): Promise<boolean> {
  const start = wallet.syncedBlock === 0n
    ? wallet.chain.deploymentBlock
    : wallet.syncedBlock + 1n;
  if (start > head) {
    // A same-head sync still refreshes PPOI list status and TXID availability.
    await wallet.sync();
    return wallet.syncedBlock >= head;
  }
  const total = Number((head - start) / SYNC_WINDOW + 1n);
  const progress = addSyncUnits("rpc", total, "Railgun history");
  for (let from = start; from <= head; from += SYNC_WINDOW) {
    const to = from + SYNC_WINDOW - 1n < head ? from + SYNC_WINDOW - 1n : head;
    await wallet.syncTo(to);
    if (wallet.syncedBlock < to) return false;
    progress.advance();
  }
  return true;
}

function reportPoi(result: PoiProcessReport): void {
  if (result.pendingBefore === 0) return;
  const pieces = [
    `${result.submitted.length} submitted`,
    `${result.waitingForTxid.length} awaiting TXID`,
    `${result.waitingForInputPoi.length} awaiting input PPOI`,
    `${result.failed.length} failed`,
    `${result.pendingAfter} pending`,
  ];
  console.error(`Railgun PPOI recovery: ${pieces.join(", ")}. Submitted proofs await list inclusion before they become spendable.`);
  for (const failure of result.failed) {
    console.error(`Railgun PPOI ${failure.txid}: ${failure.error}`);
  }
}

/** CLI-facing bridge. The encrypted Host store owns the Rust checkpoint. */
export class RailgunAdapter {
  private syncPromise?: Promise<void>;
  private lastSyncedAt = 0;
  private accountPrivateKey?: Hex;
  private bundlerUrl?: string;

  private constructor(
    readonly wallet: RailgunWallet,
    private readonly rpcUrl: string,
    private readonly storage: Host["storage"],
    private readonly migratingOldFile: boolean,
  ) {}

  static async open(host: Host, chainId: bigint): Promise<RailgunAdapter> {
    const { rpcUrl, walletDir } = railgunHostContext(host);
    const checkpointJson = await host.storage.get(CHECKPOINT_KEY);
    const migratingOldFile = existsSync(join(walletDir, "rg-storage.json")) &&
      await host.storage.get(MIGRATION_COMPLETE_KEY) !== "true";
    if (migratingOldFile &&
        !warnedResync.has(walletDir)) {
      warnedResync.add(walletDir);
      console.error(checkpointJson
        ? "Railgun v0.0.16: resuming the history resync from the saved Rust checkpoint. The old Railgun wallet file is preserved."
        : "Railgun v0.0.16: resyncing from chain history into a new encrypted checkpoint. The old Railgun wallet file is preserved. This may take several minutes and can resume after interruption.");
    }
    const paths = railgunKeyPaths(0);
    const [spendingKey, viewingKey] = await Promise.all([
      host.keystore.deriveAt(paths.spending),
      host.keystore.deriveAt(paths.viewing),
    ]);
    const wallet = await RailgunWallet.open({
      chainId,
      rpcUrl,
      spendingKey: spendingKey as Hex,
      viewingKey: viewingKey as Hex,
      checkpointJson,
      artifactBaseUrl: DEFAULT_ARTIFACTS_BASE_URL,
      persistCheckpoint: (json) => host.storage.set(CHECKPOINT_KEY, json),
    });
    return new RailgunAdapter(wallet, rpcUrl, host.storage, migratingOldFile);
  }

  configureSpend(accountPrivateKey: Hex, bundlerUrl: string): void {
    this.accountPrivateKey = accountPrivateKey;
    this.bundlerUrl = bundlerUrl;
  }

  private spendConfig(): { accountPrivateKey: Hex; bundlerUrl: string } {
    if (!this.accountPrivateKey || !this.bundlerUrl) {
      throw new Error("Railgun spend account and bundler are not configured");
    }
    return { accountPrivateKey: this.accountPrivateKey, bundlerUrl: this.bundlerUrl };
  }

  async sync(): Promise<void> {
    if (this.syncPromise) return this.syncPromise;
    this.syncPromise = this.syncNow();
    try { await this.syncPromise; }
    finally { this.syncPromise = undefined; }
  }

  private async syncNow(): Promise<void> {
    const head = await chainHead(this.rpcUrl);
    const reachedHead = await syncRailgunHistory(this.wallet, head);
    if (!reachedHead) {
      console.error(`Railgun history source is currently at block ${this.wallet.syncedBlock}; chain head is ${head}. The resync will continue on the next run.`);
    }
    if (this.wallet.pendingPoi().length > 0) {
      const finish = beginSyncActivity("Railgun PPOI recovery");
      try {
        const result = await this.wallet.processPendingPoi();
        reportPoi(result);
        if (result.submitted.length > 0) await this.wallet.sync();
      } finally { finish(); }
    }
    if (this.migratingOldFile && reachedHead) {
      await this.storage.set(MIGRATION_COMPLETE_KEY, "true");
    }
    this.lastSyncedAt = Date.now();
  }

  private async ensureSynced(): Promise<void> {
    if (Date.now() - this.lastSyncedAt > 30_000) await this.sync();
  }

  async balance(_assets?: unknown[]): Promise<AssetAmount[]> {
    await this.ensureSynced();
    return (await this.wallet.balances()).map(railgunBalanceForCli);
  }

  async notes(_assets?: unknown[], _includeSpent?: boolean): Promise<unknown[]> {
    await this.ensureSynced();
    return (await this.wallet.notes()).map(railgunNoteForCli);
  }

  async prepareShield(asset: AssetAmount): Promise<unknown> {
    const amount = BigInt(asset.amount);
    const entry = (asset.asset as { __type?: string }).__type === "native"
      ? { kind: "native" as const, amount }
      : { kind: "erc20" as const, token: assetAddress(asset.asset, this.wallet.chain.wrappedBaseToken), amount };
    return buildShieldCalls(this.wallet.chain.chainId, this.wallet.address, [entry]);
  }

  async prepareUnshield(
    asset: AssetAmount,
    recipient: Hex,
    options?: { tailCalls?: () => Promise<Array<{ to: Hex; value: bigint; data: Hex }>> },
  ): Promise<PreparedUserOperation> {
    const calls = await options?.tailCalls?.() ?? [];
    return this.wallet.prepareUnshield(railgunUnshieldInput(
      asset, recipient, calls, this.wallet.chain.wrappedBaseToken, this.spendConfig(),
    ));
  }

  close(): void { this.wallet.close(); }
}

export async function createRailgunAdapter(host: Host, chainId: bigint): Promise<RailgunAdapter> {
  return RailgunAdapter.open(host, chainId);
}
