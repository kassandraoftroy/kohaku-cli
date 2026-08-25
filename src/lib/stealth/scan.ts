import checkStealthAddress from "@scopelift/stealth-address-sdk/dist/utils/crypto/checkStealthAddress.js";
import computeStealthKey from "@scopelift/stealth-address-sdk/dist/utils/crypto/computeStealthKey.js";
import getViewTagFromMetadata from "@scopelift/stealth-address-sdk/dist/utils/helpers/getViewTagFromMetadata.js";
import { STEALTH_SCHEME_ID } from "eth-stealth-address-resolver";
import { getAddress, parseAbiItem, type Hex, type Log } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { resolveGetLogsMaxBlockSpan } from "../../host/chunked-get-logs.js";
import type { KohakuPublicClient } from "../../utils/rpc.js";
import { countSyncRequest, noteSyncFirstRun } from "../../utils/sync-progress.js";
import {
  STEALTH_ANNOUNCER_ADDRESS,
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

/**
 * Scan ERC-5564 announcements for payments to this wallet's stealth keys and
 * persist any new stealth accounts.
 *
 * Existing wallets without `stealth-accounts.json` get an empty store created
 * automatically (same wallet password / AES envelope as other stores).
 *
 * History:
 * - First run (or stores that never completed a full pass): from announcer
 *   deploy block (or `startFromBlock` if higher) → latest, in
 *   KOHAKU_GETLOGS_MAX_BLOCK_SPAN chunks (default 499).
 * - Later runs: lastScannedBlock+1 → latest only.
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
   * the announcer deploy block. Incremental scans still resume from
   * lastScannedBlock+1.
   */
  startFromBlock?: bigint;
}): Promise<StealthScanResult> {
  // Creates stealth-accounts.json on first use for pre-existing wallets.
  const storage = makeStealthAccountsStorage(opts.walletDir, opts.password);
  if (!storage.getStore().metaAddressURI) {
    storage.setMeta({ metaAddressURI: opts.keypair.stealthMetaAddressURI });
  }

  const latest = await opts.client.getBlockNumber();
  const announcerDeploy = stealthAnnouncerStartBlock(opts.chainId);
  const startFloor =
    opts.startFromBlock !== undefined && opts.startFromBlock > announcerDeploy
      ? opts.startFromBlock
      : announcerDeploy;
  const store = storage.getStore();
  const needsFullHistory =
    opts.fullRescan || !store.fullHistoryScanned;
  // `stealth-accounts.json` can exist without a scan (profile / account writes),
  // so the full-history flag is the only reliable "first scan" signal.
  noteSyncFirstRun(!store.fullHistoryScanned);

  let fromBlock: bigint;
  if (needsFullHistory) {
    // Resume mid-pass from lastScannedBlock when present; allow --stealth-start-block
    // to jump the floor forward past an earlier cursor.
    fromBlock = startFloor;
    if (store.lastScannedBlock) {
      const resume = BigInt(store.lastScannedBlock) + 1n;
      if (resume > fromBlock) fromBlock = resume;
    }
  } else {
    const stored = store.lastScannedBlock;
    fromBlock = stored ? BigInt(stored) + 1n : startFloor;
  }

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
