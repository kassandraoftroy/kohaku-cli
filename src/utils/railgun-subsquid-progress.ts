import type { SupportedProtocol } from "./plugins.js";
import { reportSyncProgress } from "./sync-progress.js";
import { kohakuFetch } from "./tor.js";

/**
 * `SubsquidSyncer::new` in railgun-rs pages GraphQL at this size, then
 * fetches one empty terminating page per stream (`fetch_paged`).
 */
export const RAILGUN_SUBSQUID_PAGE_SIZE = 20_000;

/**
 * UtxoSyncer and TxidSyncer each call `latest_block()` (BlockNumberQuery)
 * before paging commitments / nullifiers / transactions.
 */
const LATEST_BLOCK_QUERIES = 2;

/**
 * Fallback URLs from railgun-rs `ChainConfig` (WASM `chainConfig()` is not
 * safe to call before `ensureInitialized`, which happens only when the
 * plugin is constructed).
 */
const SUBSQUID_ENDPOINTS: Record<string, string> = {
  "1": "https://rail-squid.squids.live/squid-railgun-ethereum-v2/v/v1/graphql",
  "11155111":
    "https://rail-squid.squids.live/squid-railgun-eth-sepolia-v2/v/v1/graphql",
};

const COUNT_QUERY = `query RailgunSyncEstimate {
  commitmentsConnection(orderBy: id_ASC) { totalCount }
  nullifiersConnection(orderBy: id_ASC) { totalCount }
  transactionsConnection(orderBy: id_ASC) { totalCount }
}`;

function pagesForCount(count: number): number {
  if (!Number.isFinite(count) || count <= 0) return 1;
  return Math.ceil(count / RAILGUN_SUBSQUID_PAGE_SIZE) + 1;
}

type CountResponse = {
  errors?: { message?: string }[];
  data?: {
    commitmentsConnection?: { totalCount?: number };
    nullifiersConnection?: { totalCount?: number };
    transactionsConnection?: { totalCount?: number };
  };
};

function asCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * One GraphQL count query so the Railgun spinner can show a stable
 * `done/total` (not n/n+1). Cold-sync estimate: this probe + 2 latest-block
 * queries + paged commitments, nullifiers, and transactions. Incremental
 * sync may finish early. Failures leave progress as a request count only.
 */
export async function primeRailgunSubsquidProgress(
  chainId: bigint
): Promise<void> {
  const endpoint = SUBSQUID_ENDPOINTS[chainId.toString()];
  if (!endpoint) return;

  const res = await kohakuFetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: COUNT_QUERY }),
  });
  if (!res.ok) return;

  const json = (await res.json()) as CountResponse;
  if (json.errors?.length || !json.data) return;

  const commitments = asCount(json.data.commitmentsConnection?.totalCount);
  const nullifiers = asCount(json.data.nullifiersConnection?.totalCount);
  const transactions = asCount(json.data.transactionsConnection?.totalCount);
  if (
    commitments == null ||
    nullifiers == null ||
    transactions == null
  ) {
    return;
  }

  // Probe HTTP is already counted. WASM still does latest-block + 3 streams.
  const total =
    1 +
    LATEST_BLOCK_QUERIES +
    pagesForCount(commitments) +
    pagesForCount(nullifiers) +
    pagesForCount(transactions);
  reportSyncProgress({ phase: "subsquid", total });
}

export async function primeRailgunSubsquidProgressIfNeeded(
  protocol: SupportedProtocol,
  chainId: bigint
): Promise<void> {
  if (protocol !== "railgun") return;
  try {
    await primeRailgunSubsquidProgress(chainId);
  } catch {
    // Leave the spinner on request-count + elapsed (no fake n/n+1 bar).
  }
}
