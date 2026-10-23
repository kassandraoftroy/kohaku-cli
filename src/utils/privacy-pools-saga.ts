/**
 * Privacy Pools historical sync from the saga CDN.
 *
 * Mainnet publishes pool and entrypoint events at
 * `https://saga-pp-state.global.ssl.fastly.net`. The SDK rebuilds leaves from
 * those events and the chain fills only the blocks past saga's coverage.
 * Sepolia's saga index has no Privacy Pools streams, so that chain stays on
 * `eth_getLogs`.
 */
import type { Host } from "@kohaku-eth/plugins";
import { DataService } from "@kohaku-eth/privacy-pools";
import { Client, HttpStore, type CanonicalEvent } from "@saga-sync/client";
import { addSyncUnits } from "./sync-progress.js";
import {
  decodeEventLog,
  encodeAbiParameters,
  parseAbi,
  toEventSelector,
  type Hex,
} from "viem";

const MAINNET_SAGA_URL = "https://saga-pp-state.global.ssl.fastly.net";

/** Matches `@saga-sync/client`'s default in-flight window. */
const SAGA_CHUNK_CONCURRENCY = 4;

type SagaChunkMeta = Parameters<Client["fetchChunk"]>[0];

/**
 * Half-open `[from, to)` overlap. Same rule as the client's unexported
 * `selectSealedChunks` / `selectHotHead`.
 */
function chunkOverlapsWindow(
  chunk: { fromBlock: string; toBlock: string },
  from: bigint,
  to: bigint
): boolean {
  const cFrom = BigInt(chunk.fromBlock);
  const cTo = BigInt(chunk.toBlock);
  return cTo > from && cFrom < to;
}

/**
 * Sealed chunks in block order, with a small in-flight window, then the hot
 * head. `advance` runs once per chunk after that chunk is in hand.
 */
async function loadSagaEvents(
  client: Client,
  chunks: SagaChunkMeta[],
  hot: SagaChunkMeta | undefined,
  advance: () => void
): Promise<CanonicalEvent[]> {
  const events: CanonicalEvent[] = [];
  const queue: Promise<CanonicalEvent[]>[] = [];
  let next = 0;
  while (next < chunks.length && queue.length < SAGA_CHUNK_CONCURRENCY) {
    queue.push(client.fetchChunk(chunks[next++]!));
  }
  while (queue.length > 0) {
    const batch = await queue.shift()!;
    if (next < chunks.length) queue.push(client.fetchChunk(chunks[next++]!));
    events.push(...batch);
    advance();
  }
  if (hot) {
    events.push(...(await client.fetchChunk(hot, { hot: true })));
    advance();
  }
  return events;
}

const LEAF_ABI = parseAbi([
  "event Deposited(address indexed _depositor, uint256 _commitment, uint256 _label, uint256 _value, uint256 _precommitment)",
  "event Withdrawn(address indexed _processooor, uint256 _value, uint256 _spentNullifier, uint256 _newCommitment)",
]);

const LEAF_INSERTED_TOPIC = toEventSelector(
  "event LeafInserted(uint256 _index, uint256 _leaf, uint256 _root)"
);

type SagaLog = {
  address: string;
  data: string;
  topics: string[];
  blockNumber: bigint;
  logIndex?: number;
};

type GetLogsParams = {
  address: string;
  fromBlock: bigint;
  toBlock?: bigint;
};

/** Saga base URL for chains that publish Privacy Pools. Sepolia returns none. */
export function privacyPoolsSagaSourceUrl(chainId: bigint): string | undefined {
  if (chainId === 1n) return MAINNET_SAGA_URL;
  return undefined;
}

/**
 * Exclusive end of saga coverage (`chunk.toBlock` / hot-head `toBlock`).
 * Blocks below this value are in the CDN; this block and later come from RPC.
 */
export function privacyPoolsSagaExclusiveEnd(entry: {
  chunks?: readonly { toBlock: string }[];
  hotHead?: { toBlock: string };
}): bigint | null {
  const chunks = entry.chunks ?? [];
  const last = chunks.length > 0 ? chunks[chunks.length - 1] : undefined;
  const sealedTo = last ? BigInt(last.toBlock) : null;
  const hotTo = entry.hotHead ? BigInt(entry.hotHead.toBlock) : null;
  if (sealedTo === null) return hotTo;
  if (hotTo === null) return sealedTo;
  return sealedTo > hotTo ? sealedTo : hotTo;
}

/**
 * `saga` replays CDN events up to (but not including) `sagaTo`, then `tailFrom`
 * is the first block that must come from `eth_getLogs`. `rpc` means the whole
 * request is already past saga, or saga has nothing for this pool.
 */
export function privacyPoolsSagaLogPlan(opts: {
  fromBlock: bigint;
  toBlock?: bigint;
  sagaLast: bigint | null;
}):
  | { kind: "rpc" }
  | { kind: "saga"; sagaTo: bigint; tailFrom?: bigint } {
  if (opts.sagaLast === null || opts.fromBlock >= opts.sagaLast) {
    return { kind: "rpc" };
  }
  const sagaTo =
    opts.toBlock !== undefined && opts.toBlock < opts.sagaLast
      ? opts.toBlock + 1n
      : opts.sagaLast;
  const needsTail = opts.toBlock === undefined || opts.toBlock >= opts.sagaLast;
  return {
    kind: "saga",
    sagaTo,
    ...(needsTail ? { tailFrom: opts.sagaLast } : {}),
  };
}

function insertedLeaf(ev: CanonicalEvent): bigint | null {
  try {
    const decoded = decodeEventLog({
      abi: LEAF_ABI,
      topics: ev.topics as [Hex, ...Hex[]],
      data: ev.data,
    });
    if (decoded.eventName === "Deposited") return decoded.args._commitment;
    if (decoded.eventName === "Withdrawn") return decoded.args._newCommitment;
  } catch {
    // Entrypoint and other events have no pool leaf.
  }
  return null;
}

function synthLeafInsertedLog(
  pool: string,
  index: bigint,
  leaf: bigint,
  blockNumber: bigint
): SagaLog {
  return {
    address: pool,
    topics: [LEAF_INSERTED_TOPIC],
    data: encodeAbiParameters(
      [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }],
      [index, leaf, 0n]
    ),
    blockNumber,
  };
}

function toSagaLog(ev: CanonicalEvent): SagaLog {
  return {
    address: ev.contractAddress,
    data: ev.data,
    topics: [...ev.topics],
    blockNumber: BigInt(ev.blockNumber),
    logIndex: Number(ev.logIndex),
  };
}

/**
 * Turn a saga event stream into pool logs. Leaf indices count from the start
 * of the stream so a window that begins mid-history still matches the chain.
 */
export function privacyPoolsLogsFromSagaEvents(opts: {
  events: readonly CanonicalEvent[];
  pool: string;
  fromBlock: bigint;
  sagaTo: bigint;
}): SagaLog[] {
  const logs: SagaLog[] = [];
  let leafIndex = 1n;
  for (const ev of opts.events) {
    const block = BigInt(ev.blockNumber);
    const leaf = insertedLeaf(ev);
    const inWindow = block >= opts.fromBlock && block < opts.sagaTo;
    if (inWindow) logs.push(toSagaLog(ev));
    if (leaf !== null) {
      if (inWindow) {
        logs.push(synthLeafInsertedLog(opts.pool, leafIndex, leaf, block));
      }
      leafIndex += 1n;
    }
  }
  return logs;
}

function protocolIdForAddress(
  manifest: Awaited<ReturnType<Client["fetchManifest"]>>,
  address: string,
  chainId: bigint
): string | undefined {
  const addr = address.toLowerCase();
  const matches = manifest.protocolIds().filter((id) => {
    const addrs = manifest.trackedAddresses(id);
    if (!addrs?.some((a) => a.toLowerCase() === addr)) return false;
    const cid = manifest.chainId(id);
    return cid !== undefined && BigInt(cid) === chainId;
  });
  if (matches.length === 0) return undefined;
  if (matches.length > 1) {
    throw new Error(
      `Privacy Pools saga CDN lists ${address} on more than one stream (${matches.join(", ")}).`
    );
  }
  return matches[0];
}

/**
 * Data service whose pool/entrypoint logs come from the mainnet saga CDN, with
 * `eth_getLogs` only for addresses saga does not publish and for blocks past
 * saga's head.
 */
export function createPrivacyPoolsSagaDataService(opts: {
  provider: Host["provider"];
  chainId: bigint;
}): DataService {
  const sourceUrl = privacyPoolsSagaSourceUrl(opts.chainId);
  if (!sourceUrl) {
    throw new Error(
      "Privacy Pools saga CDN is not available on this chain; sync from eth_getLogs."
    );
  }
  const client = new Client({ source: new HttpStore(sourceUrl) });
  let manifestPromise: Promise<Awaited<ReturnType<Client["fetchManifest"]>>> | null =
    null;
  const manifest = () => {
    manifestPromise ??= client.fetchManifest().catch((err: unknown) => {
      manifestPromise = null;
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Privacy Pools saga CDN is unavailable (${sourceUrl}): ${detail}`
      );
    });
    return manifestPromise;
  };

  const rpcLogs = async (params: GetLogsParams): Promise<SagaLog[]> => {
    const toBlock = params.toBlock ?? (await opts.provider.getBlockNumber());
    if (params.fromBlock > toBlock) return [];
    return opts.provider.getLogs({
      address: params.address as Hex,
      fromBlock: params.fromBlock,
      toBlock,
    });
  };

  const getLogs = async (params: GetLogsParams): Promise<SagaLog[]> => {
    const index = await manifest();
    const protocolId = protocolIdForAddress(index, params.address, opts.chainId);
    const sagaLast = protocolId ? index.lastCoveredBlock(protocolId) : null;
    const plan = privacyPoolsSagaLogPlan({
      fromBlock: params.fromBlock,
      toBlock: params.toBlock,
      sagaLast,
    });
    if (plan.kind === "rpc" || !protocolId) return rpcLogs(params);

    const sealed = index
      .sealedChunks(protocolId)
      .filter((chunk) => chunkOverlapsWindow(chunk, 0n, plan.sagaTo));
    const hotHead = index.hotHead(protocolId);
    const hot =
      hotHead && chunkOverlapsWindow(hotHead, 0n, plan.sagaTo) ? hotHead : undefined;
    const chunkTotal = sealed.length + (hot ? 1 : 0);
    const progress = addSyncUnits("saga", chunkTotal, `Saga ${params.address.slice(0, 8)}…${params.address.slice(-4)}`);
    const events =
      chunkTotal === 0
        ? []
        : await loadSagaEvents(client, sealed, hot, () => progress.advance());
    const logs = privacyPoolsLogsFromSagaEvents({
      events,
      pool: params.address,
      fromBlock: params.fromBlock,
      sagaTo: plan.sagaTo,
    });
    if (plan.tailFrom !== undefined) {
      logs.push(
        ...(await rpcLogs({
          ...params,
          fromBlock: plan.tailFrom,
        }))
      );
    }
    return logs;
  };

  return new DataService({
    provider: opts.provider,
    getLogs,
  });
}
