import { chainConfig } from "@kohaku-eth/railgun";

import type { SupportedProtocol } from "./plugins.js";
import { reportSyncProgress } from "./sync-progress.js";
import { kohakuFetch } from "./tor.js";

/**
 * `SubsquidSyncer::new` in `@kohaku-eth/railgun` (railgun-rs) pages GraphQL at
 * this size. Each entity stream also issues one empty terminating request.
 */
export const RAILGUN_SUBSQUID_PAGE_SIZE = 20_000;

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
  data?: {
    commitmentsConnection?: { totalCount?: number };
    nullifiersConnection?: { totalCount?: number };
    transactionsConnection?: { totalCount?: number };
  };
};

/**
 * One GraphQL count query so the Railgun spinner can show `done/total`
 * Subsquid requests. Cold-sync estimate: latest-block query + paged
 * commitments, nullifiers, and transactions. Incremental sync may finish
 * early (bar jumps to complete). Failures leave progress indeterminate.
 */
export async function primeRailgunSubsquidProgress(
  chainId: bigint
): Promise<void> {
  const chain = chainConfig(chainId);
  const endpoint = chain?.subsquidEndpoint;
  if (!endpoint) return;

  const res = await kohakuFetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: COUNT_QUERY }),
  });
  if (!res.ok) return;

  const json = (await res.json()) as CountResponse;
  const commitments = json.data?.commitmentsConnection?.totalCount ?? 0;
  const nullifiers = json.data?.nullifiersConnection?.totalCount ?? 0;
  const transactions = json.data?.transactionsConnection?.totalCount ?? 0;

  // Probe HTTP is already counted. WASM still does latest-block + 3 streams.
  const total =
    1 +
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
    // Leave the spinner on request-count + elapsed.
  }
}
