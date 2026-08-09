import checkStealthAddress from "@scopelift/stealth-address-sdk/dist/utils/crypto/checkStealthAddress.js";
import computeStealthKey from "@scopelift/stealth-address-sdk/dist/utils/crypto/computeStealthKey.js";
import getViewTagFromMetadata from "@scopelift/stealth-address-sdk/dist/utils/helpers/getViewTagFromMetadata.js";
import { getAddress, parseAbiItem, type Hex, type Log } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { resolveGetLogsMaxBlockSpan } from "../../host/chunked-get-logs.js";
import type { KohakuPublicClient } from "../../utils/rpc.js";
import {
  STEALTH_ANNOUNCER_ADDRESS,
  STEALTH_SCHEME_ID,
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

/**
 * Scan ERC-5564 announcements for payments to this wallet's stealth keys and
 * persist any new stealth accounts.
 *
 * Existing wallets without `stealth-accounts.json` get an empty store created
 * automatically (same wallet password / AES envelope as other stores).
 *
 * History:
 * - First run (or stores that never completed a full pass): from announcer
 *   deploy block → latest, in KOHAKU_GETLOGS_MAX_BLOCK_SPAN chunks (default 499).
 * - Later runs: lastScannedBlock+1 → latest only.
 */
export async function scanAndImportStealthAnnouncements(opts: {
  client: KohakuPublicClient;
  walletDir: string;
  password: string;
  keypair: StealthKeypair;
  chainId: bigint;
  /** Force rescan from announcer deploy block (ignore lastScannedBlock). */
  fullRescan?: boolean;
  onProgress?: (msg: string) => void;
}): Promise<StealthScanResult> {
  // Creates stealth-accounts.json on first use for pre-existing wallets.
  const storage = makeStealthAccountsStorage(opts.walletDir, opts.password);
  if (!storage.getStore().metaAddressURI) {
    storage.setMeta({ metaAddressURI: opts.keypair.stealthMetaAddressURI });
  }

  const latest = await opts.client.getBlockNumber();
  const startDefault = stealthAnnouncerStartBlock(opts.chainId);
  const store = storage.getStore();
  const needsFullHistory =
    opts.fullRescan || !store.fullHistoryScanned;

  let fromBlock: bigint;
  if (needsFullHistory) {
    // Always cover the entire announcer history at least once (chunked below).
    fromBlock = startDefault;
  } else {
    const stored = store.lastScannedBlock;
    fromBlock = stored ? BigInt(stored) + 1n : startDefault;
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
  let chunk = 0;

  let cursor = fromBlock;
  while (cursor <= latest) {
    const to = cursor + maxSpan - 1n > latest ? latest : cursor + maxSpan - 1n;
    chunk += 1;
    // Rate-limit progress noise on multi-thousand-chunk full history scans.
    if (chunk === 1 || chunk % 25 === 0 || to === latest) {
      opts.onProgress?.(
        `Scanning stealth announcements blocks ${cursor}–${to} / ${latest}` +
          (needsFullHistory ? " (full history)" : "") +
          "…"
      );
    }

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
