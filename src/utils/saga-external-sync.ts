import { createGunzip } from "node:zlib";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import type {
  ExternalRawEvent,
  ExternalSyncPoolId,
  ExternalSyncProvider,
  Network,
} from "@kohaku-eth/plugins";

type Hex = `0x${string}`;

type SagaChunk = {
  fromBlock: Hex;
  toBlock: Hex;
  file: string;
};

type SagaProtocolEntry = {
  chainId: Hex;
  trackedAddresses: string[];
  chunks: SagaChunk[];
  hotHead?: SagaChunk;
};

type SagaIndex = {
  availableProtocols: Record<string, SagaProtocolEntry>;
};

/** CDN base URL for historical event sync (mainnet vs Sepolia). */
export function sagaBaseUrlForChain(chainId: bigint): string {
  return chainId === 11155111n
    ? "https://saga.gordosoluciones.xyz/sepolia"
    : "https://saga.gordosoluciones.xyz";
}

function normalizeAddress(address: Hex): string {
  return address.toLowerCase();
}

function hexToBigInt(hex: Hex): bigint {
  return BigInt(hex);
}

function inclusiveLastBlock(chunk: SagaChunk): bigint {
  return hexToBigInt(chunk.toBlock) - 1n;
}

function collectSegments(entry: SagaProtocolEntry): SagaChunk[] {
  const segments = [...(entry.chunks ?? [])];
  if (entry.hotHead) segments.push(entry.hotHead);
  return segments.sort(
    (a, b) =>
      Number(hexToBigInt(a.fromBlock) - hexToBigInt(b.fromBlock)) ||
      Number(hexToBigInt(a.toBlock) - hexToBigInt(b.toBlock))
  );
}

async function loadIndex(
  network: Network,
  baseUrl: string
): Promise<SagaIndex> {
  const res = await network.fetch(`${baseUrl}/index.json`);
  if (!res.ok) {
    throw new Error(
      `Saga index fetch failed (${res.status}): ${baseUrl}/index.json`
    );
  }
  return (await res.json()) as SagaIndex;
}

function findProtocolEntry(
  index: SagaIndex,
  params: ExternalSyncPoolId
): SagaProtocolEntry | undefined {
  const chainId = params.chainId.toLowerCase();
  const address = normalizeAddress(params.address);
  return Object.values(index.availableProtocols).find(
    (entry) =>
      entry.chainId.toLowerCase() === chainId &&
      entry.trackedAddresses.some((a) => a.toLowerCase() === address)
  );
}

async function readGunzipLines(
  network: Network,
  url: string
): Promise<string[]> {
  const res = await network.fetch(url);
  if (!res.ok) {
    throw new Error(`Saga chunk fetch failed (${res.status}): ${url}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const lines: string[] = [];
  const gunzip = createGunzip();
  const source = Readable.from(buf);
  let pending = "";
  gunzip.on("data", (chunk: Buffer) => {
    pending += chunk.toString("utf8");
    let idx = pending.indexOf("\n");
    while (idx >= 0) {
      const line = pending.slice(0, idx).trim();
      if (line) lines.push(line);
      pending = pending.slice(idx + 1);
      idx = pending.indexOf("\n");
    }
  });
  await pipeline(source, gunzip);
  const tail = pending.trim();
  if (tail) lines.push(tail);
  return lines;
}

/**
 * Host {@link ExternalSyncProvider} backed by the saga CDN.
 * Tornado Cash reads bulk historical logs from here during cold sync.
 *
 * Every fetch here is counted as a saga request by the Tor fetch wrapper, so
 * this provider does no progress bookkeeping of its own.
 */
export function createSagaExternalSyncProvider(opts: {
  baseUrl: string;
  network: Network;
}): ExternalSyncProvider & {
  firstCoveredBlock(params: ExternalSyncPoolId): Promise<Hex>;
} {
  let indexPromise: Promise<SagaIndex> | null = null;

  const getIndex = () => {
    indexPromise ??= loadIndex(opts.network, opts.baseUrl);
    return indexPromise;
  };

  const getEntry = async (params: ExternalSyncPoolId) => {
    const entry = findProtocolEntry(await getIndex(), params);
    if (!entry) {
      throw new Error(
        `Saga has no protocol data for chain ${params.chainId} address ${params.address}`
      );
    }
    return entry;
  };

  return {
    async firstCoveredBlock(params) {
      const segments = collectSegments(await getEntry(params));
      if (segments.length === 0) {
        throw new Error(
          `Saga has no segments for chain ${params.chainId} address ${params.address}`
        );
      }
      const first = segments.reduce((min, seg) => {
        const from = hexToBigInt(seg.fromBlock);
        return from < min ? from : min;
      }, hexToBigInt(segments[0]!.fromBlock));
      return `0x${first.toString(16)}` as Hex;
    },

    async lastCoveredBlock(params) {
      const segments = collectSegments(await getEntry(params));
      if (segments.length === 0) {
        throw new Error(
          `Saga has no segments for chain ${params.chainId} address ${params.address}`
        );
      }
      const last = segments.reduce((max, seg) => {
        const end = inclusiveLastBlock(seg);
        return end > max ? end : max;
      }, inclusiveLastBlock(segments[0]!));
      return `0x${last.toString(16)}` as Hex;
    },

    async *streamEvents(params) {
      const entry = await getEntry(params);
      const fromBlock = hexToBigInt(params.fromBlock);
      const toBlock = hexToBigInt(params.toBlock);
      const segments = collectSegments(entry).filter((seg) => {
        const segFrom = hexToBigInt(seg.fromBlock);
        const segLast = inclusiveLastBlock(seg);
        return segFrom <= toBlock && segLast >= fromBlock;
      });

      const out: ExternalRawEvent[] = [];
      for (const seg of segments) {
        const url = `${opts.baseUrl}/${seg.file}`;
        const lines = await readGunzipLines(opts.network, url);
        for (const line of lines) {
          let parsed: ExternalRawEvent;
          try {
            parsed = JSON.parse(line) as ExternalRawEvent;
          } catch {
            continue;
          }
          const block = hexToBigInt(parsed.blockNumber);
          if (block < fromBlock || block > toBlock) continue;
          out.push(parsed);
        }
      }

      out.sort((a, b) => {
        const blockCmp = Number(hexToBigInt(a.blockNumber) - hexToBigInt(b.blockNumber));
        if (blockCmp !== 0) return blockCmp;
        return Number(hexToBigInt(a.logIndex) - hexToBigInt(b.logIndex));
      });

      for (const event of out) {
        yield event;
      }
    },
  };
}

export function tornadoExternalSyncForChain(
  chainId: bigint,
  network: Network
): ExternalSyncProvider & {
  firstCoveredBlock(params: ExternalSyncPoolId): Promise<Hex>;
} {
  return createSagaExternalSyncProvider({
    baseUrl: sagaBaseUrlForChain(chainId),
    network,
  });
}
