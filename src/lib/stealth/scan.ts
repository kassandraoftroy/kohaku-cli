import checkStealthAddress from "@scopelift/stealth-address-sdk/dist/utils/crypto/checkStealthAddress.js";
import computeStealthKey from "@scopelift/stealth-address-sdk/dist/utils/crypto/computeStealthKey.js";
import getViewTagFromMetadata from "@scopelift/stealth-address-sdk/dist/utils/helpers/getViewTagFromMetadata.js";
import { STEALTH_SCHEME_ID } from "eth-stealth-address-resolver";
import { getAddress, parseAbiItem, type Hex, type Log } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { resolveGetLogsMaxBlockSpan } from "../../host/chunked-get-logs.js";
import type { KohakuPublicClient } from "../../utils/rpc.js";
import { countSyncRequest, noteSyncFirstRun, reportSyncBlockProgress } from "../../utils/sync-progress.js";
import {
  STEALTH_ANNOUNCER_ADDRESS,
  defaultStealthImportStartBlock,
  stealthAnnouncerStartBlock,
} from "./constants.js";
import type { StealthKeypair } from "./keys.js";
import {
  makeStealthAccountsStorage,
  type StealthAccount,
  type StealthAccountsStorage,
} from "./storage.js";

const ANNOUNCEMENT_EVENT = parseAbiItem(
  "event Announcement(uint256 indexed schemeId, address indexed stealthAddress, address indexed caller, bytes ephemeralPubKey, bytes metadata)"
);

export type StealthScanResult = {
  scannedFrom: bigint;
  scannedTo: bigint;
  announcementsChecked: number;
  newlyImported: StealthAccount[];
  alreadyKnown: number;
  /** True when this run covered history from the announcer deploy block. */
  fullHistoryPass: boolean;
};

/** Parse `--stealth-start-block` (decimal or 0x-hex). */
export function parseStealthStartBlock(raw: string): bigint {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("--stealth-start-block must be a non-empty block number.");
  }
  if (!/^(0x[0-9a-fA-F]+|[0-9]+)$/.test(trimmed)) {
    throw new Error(
      `--stealth-start-block must be a decimal or 0x-hex block number (got "${raw}").`
    );
  }
  let block: bigint;
  try {
    block = BigInt(trimmed);
  } catch {
    throw new Error(`Invalid --stealth-start-block: ${raw}`);
  }
  if (block < 0n) {
    throw new Error("--stealth-start-block must be >= 0.");
  }
  return block;
}

export type StealthScanWindowInput = {
  chainId: bigint;
  latest: bigint;
  /**
   * Inclusive lower bound from `--stealth-start-block`, `.stealth-start-block`,
   * or omitted (Kohaku import default). Clamped to at least the announcer
   * deploy block.
   */
  startFromBlock?: bigint;
  lastScannedBlock?: string | null;
  fullHistoryScanned?: boolean;
  fullRescan?: boolean;
  /**
   * True when the user passed `--stealth-start-block` on this run. Allows
   * starting below `lastScannedBlock+1`. The wallet file must not set this —
   * `balances` already passes the file as `startFromBlock` on every run.
   */
  backdate?: boolean;
};

export type StealthScanWindow = {
  fromBlock: bigint;
  latest: bigint;
  startFloor: bigint;
  needsFullHistory: boolean;
};

/**
 * Inclusive first-pass floor: max(requested or Kohaku default, announcer deploy).
 */
export function resolveStealthScanFloor(opts: {
  chainId: bigint;
  startFromBlock?: bigint;
}): bigint {
  const announcerDeploy = stealthAnnouncerStartBlock(opts.chainId);
  const requested =
    opts.startFromBlock !== undefined
      ? opts.startFromBlock
      : defaultStealthImportStartBlock(opts.chainId);
  return requested > announcerDeploy ? requested : announcerDeploy;
}

/** First/full vs incremental stealth `getLogs` window. */
export function resolveStealthScanWindow(
  opts: StealthScanWindowInput
): StealthScanWindow {
  const startFloor = resolveStealthScanFloor({
    chainId: opts.chainId,
    startFromBlock: opts.startFromBlock,
  });
  const needsFullHistory = Boolean(opts.fullRescan || !opts.fullHistoryScanned);
  const lastScanned = opts.lastScannedBlock
    ? BigInt(opts.lastScannedBlock)
    : null;

  let fromBlock: bigint;
  if (needsFullHistory) {
    // Resume mid-pass from lastScannedBlock when present; allow a higher
    // --stealth-start-block to jump the floor forward past an earlier cursor.
    fromBlock = startFloor;
    if (lastScanned !== null) {
      const resume = lastScanned + 1n;
      if (resume > fromBlock) fromBlock = resume;
    }
  } else {
    fromBlock = lastScanned !== null ? lastScanned + 1n : startFloor;
  }

  if (opts.backdate && startFloor < fromBlock) {
    fromBlock = startFloor;
  }

  return {
    fromBlock,
    latest: opts.latest,
    startFloor,
    needsFullHistory,
  };
}

/** Durable line printed before the Stealth progress bar. */
export function formatStealthScanStartLog(
  fromBlock: bigint,
  latest: bigint
): string {
  return `Stealth scan from block ${fromBlock.toString()} · ${(latest - fromBlock).toString()} blocks`;
}

/**
 * Scan ERC-5564 announcements for payments to this wallet's stealth keys and
 * persist any new stealth accounts.
 *
 * Existing wallets without `stealth-accounts.json` get an empty store created
 * automatically (same wallet password / AES envelope as other stores).
 *
 * History:
 * - First run (or stores that never completed a full pass): from the Kohaku
 *   import default (or `startFromBlock` if set), clamped to at least the
 *   announcer deploy block → latest, in KOHAKU_GETLOGS_MAX_BLOCK_SPAN chunks
 *   (default 499).
 * - Later runs: lastScannedBlock+1 → latest only, unless `backdate` is set.
 */
export async function scanAndImportStealthAnnouncements(opts: {
  client: KohakuPublicClient;
  walletDir: string;
  password: string;
  keypair: StealthKeypair;
  chainId: bigint;
  /** Force rescan from the scan floor (ignore lastScannedBlock). */
  fullRescan?: boolean;
  /**
   * Inclusive lower bound for the first/full history pass. Clamped to at least
   * the announcer deploy block. When omitted, uses the Kohaku import default.
   * Incremental scans still resume from lastScannedBlock+1 unless `backdate`.
   */
  startFromBlock?: bigint;
  /**
   * When true, start from the (clamped) `startFromBlock` even if
   * lastScannedBlock is already ahead. Only the CLI flag should set this.
   */
  backdate?: boolean;
  /** Skip a second `getBlockNumber` when the caller already resolved the window. */
  latest?: bigint;
}): Promise<StealthScanResult> {
  // Creates stealth-accounts.json on first use for pre-existing wallets.
  const storage = makeStealthAccountsStorage(opts.walletDir, opts.password);
  if (!storage.getStore().metaAddressURI) {
    storage.setMeta({ metaAddressURI: opts.keypair.stealthMetaAddressURI });
  }

  const latest = opts.latest ?? (await opts.client.getBlockNumber());
  const store = storage.getStore();
  const window = resolveStealthScanWindow({
    chainId: opts.chainId,
    latest,
    startFromBlock: opts.startFromBlock,
    lastScannedBlock: store.lastScannedBlock,
    fullHistoryScanned: store.fullHistoryScanned,
    fullRescan: opts.fullRescan,
    backdate: opts.backdate,
  });
  const { fromBlock, needsFullHistory } = window;
  // `stealth-accounts.json` can exist without a scan (profile / account writes),
  // so the full-history flag is the only reliable "first scan" signal.
  noteSyncFirstRun(!store.fullHistoryScanned);

  if (fromBlock > latest) {
    if (needsFullHistory) storage.markFullHistoryScanned();
    return {
      scannedFrom: fromBlock,
      scannedTo: latest,
      announcementsChecked: 0,
      newlyImported: [],
      alreadyKnown: 0,
      fullHistoryPass: needsFullHistory,
    };
  }

  const maxSpan = resolveGetLogsMaxBlockSpan();
  const newlyImported: StealthAccount[] = [];
  let announcementsChecked = 0;
  let alreadyKnown = 0;
  const name = store.name;
  const totalBlocks = latest >= fromBlock ? latest - fromBlock + 1n : 0n;

  let cursor = fromBlock;
  while (cursor <= latest) {
    const to = cursor + maxSpan - 1n > latest ? latest : cursor + maxSpan - 1n;
    countSyncRequest("rpc");

    const logs = (await opts.client.getLogs({
      address: STEALTH_ANNOUNCER_ADDRESS,
      event: ANNOUNCEMENT_EVENT,
      args: { schemeId: BigInt(STEALTH_SCHEME_ID) },
      fromBlock: cursor,
      toBlock: to,
    })) as Array<
      Log & {
        args: {
          schemeId?: bigint;
          stealthAddress?: `0x${string}`;
          ephemeralPubKey?: Hex;
          metadata?: Hex;
        };
      }
    >;

    for (const log of logs) {
      announcementsChecked += 1;
      const result = tryImportAnnouncement({
        log,
        keypair: opts.keypair,
        storage,
        name,
      });
      if (result.status === "new") {
        newlyImported.push(result.account);
      } else if (result.status === "known") {
        alreadyKnown += 1;
      }
    }

    // Persist cursor after each chunk so a mid-scan interrupt can resume.
    storage.setLastScannedBlock(to);
    reportSyncBlockProgress(to - fromBlock + 1n, totalBlocks);
    cursor = to + 1n;
  }

  if (needsFullHistory) {
    storage.markFullHistoryScanned();
  }

  return {
    scannedFrom: fromBlock,
    scannedTo: latest,
    announcementsChecked,
    newlyImported,
    alreadyKnown,
    fullHistoryPass: needsFullHistory,
  };
}

function tryImportAnnouncement(opts: {
  log: Log & {
    args: {
      schemeId?: bigint;
      stealthAddress?: `0x${string}`;
      ephemeralPubKey?: Hex;
      metadata?: Hex;
    };
  };
  keypair: StealthKeypair;
  storage: StealthAccountsStorage;
  name?: string;
}):
  | { status: "new"; account: StealthAccount }
  | { status: "known" }
  | { status: "skip" } {
  const args = opts.log.args;
  if (!args.stealthAddress || !args.ephemeralPubKey || !args.metadata) {
    return { status: "skip" };
  }
  const stealthAddress = getAddress(args.stealthAddress);
  const ephemeralPublicKey = args.ephemeralPubKey;
  let viewTag: Hex;
  try {
    viewTag = getViewTagFromMetadata(args.metadata) as Hex;
  } catch {
    return { status: "skip" };
  }

  const intended = checkStealthAddress({
    ephemeralPublicKey,
    schemeId: STEALTH_SCHEME_ID,
    spendingPublicKey: opts.keypair.spendingPublicKey,
    userStealthAddress: stealthAddress,
    viewingPrivateKey: opts.keypair.viewingPrivateKey,
    viewTag,
  });
  if (!intended) return { status: "skip" };

  if (opts.storage.findByAddress(stealthAddress)) {
    return { status: "known" };
  }

  const priv = computeStealthKey({
    ephemeralPublicKey,
    schemeId: STEALTH_SCHEME_ID,
    spendingPrivateKey: opts.keypair.spendingPrivateKey,
    viewingPrivateKey: opts.keypair.viewingPrivateKey,
  }) as Hex;

  if (
    privateKeyToAccount(priv).address.toLowerCase() !==
    stealthAddress.toLowerCase()
  ) {
    return { status: "skip" };
  }

  const account = opts.storage.upsertAccount({
    address: stealthAddress,
    priv,
    ephemeralPublicKey,
    viewTag,
    schemeId: STEALTH_SCHEME_ID,
    announcementTxHash: opts.log.transactionHash ?? undefined,
    announcementBlock:
      opts.log.blockNumber != null ? opts.log.blockNumber.toString() : undefined,
    name: opts.name,
    lastUpdated: Date.now(),
    ethBalance: "0",
    erc20Balances: {},
  });
  return { status: "new", account };
}
