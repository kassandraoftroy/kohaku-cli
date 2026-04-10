import type { EthereumProvider } from "@kohaku-eth/provider";
import type { Filter } from "ox/Filter";
import type { RpcRequest } from "ox/RpcRequest";

/** Max inclusive block span per `eth_getLogs` call (env / option override). */
const DEFAULT_MAX_BLOCK_SPAN = 499n;

/** stderr on chunk failure only; success path stays silent. */
function logGetLogsChunkFailure(
  path: string,
  label: string,
  from: bigint,
  to: bigint,
  err: unknown
): void {
  const message = err instanceof Error ? err.message : String(err);
  console.error("[kohaku:getlogs]", path, `chunk ${label} failed`, {
    from: from.toString(),
    to: to.toString(),
    message,
  });
  if (err instanceof Error && err.cause !== undefined) {
    console.error("[kohaku:getlogs]", "cause:", err.cause);
  }
}

function parseEnvMaxBlockSpan(): bigint | null {
  const raw = process.env.KOHAKU_GETLOGS_MAX_BLOCK_SPAN?.trim();
  if (!raw) return null;
  try {
    const n = BigInt(raw);
    return n > 0n ? n : null;
  } catch {
    return null;
  }
}

function resolveMaxBlockSpan(): bigint {
  return parseEnvMaxBlockSpan() ?? DEFAULT_MAX_BLOCK_SPAN;
}

/** JSON-RPC block quantity: minimal hex (ethers-style). */
function toRpcBlockQuantity(n: bigint): string {
  if (n < 0n) throw new Error("block number must be non-negative");
  if (n === 0n) return "0x0";
  return `0x${n.toString(16)}`;
}

function blockSpecToBigInt(value: unknown): bigint | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isFinite(value)) {
    const t = Math.trunc(value);
    if (t < 0 || !Number.isSafeInteger(t)) return null;
    return BigInt(t);
  }
  if (typeof value === "string") {
    if (
      value === "latest" ||
      value === "pending" ||
      value === "earliest" ||
      value === "safe" ||
      value === "finalized"
    ) {
      return null;
    }
    if (value.startsWith("0x") || value.startsWith("0X")) {
      try {
        return BigInt(value);
      } catch {
        return null;
      }
    }
    if (/^\d+$/.test(value)) {
      try {
        return BigInt(value);
      } catch {
        return null;
      }
    }
  }
  return null;
}

function filterBlockToBigInt(
  value: Filter["fromBlock"] | Filter["toBlock"]
): bigint | null {
  return blockSpecToBigInt(value as unknown);
}

function asLogArray(result: unknown): unknown[] {
  if (Array.isArray(result)) return result;
  throw new Error(`expected eth_getLogs result to be an array, got ${typeof result}`);
}

/**
 * Step [fromBn, toBn] in fixed inclusive windows of at most `chunkSpan` blocks.
 * `invoke` errors are logged then rethrown.
 */
async function fetchLogsChunked(
  path: string,
  fromBn: bigint,
  toBn: bigint,
  chunkSpan: bigint,
  invoke: (from: bigint, to: bigint) => Promise<unknown>
): Promise<unknown[]> {
  const out: unknown[] = [];
  let windowFrom = fromBn;
  let w = 0;
  while (windowFrom <= toBn) {
    const windowTo =
      windowFrom + chunkSpan - 1n > toBn ? toBn : windowFrom + chunkSpan - 1n;
    w += 1;
    let raw: unknown;
    try {
      raw = await invoke(windowFrom, windowTo);
    } catch (e) {
      logGetLogsChunkFailure(path, `#${w}`, windowFrom, windowTo, e);
      throw e;
    }
    out.push(...asLogArray(raw));
    windowFrom = windowTo + 1n;
  }
  return out;
}

/**
 * Wraps a Kohaku {@link EthereumProvider}: `getLogs` / `eth_getLogs` are issued
 * in sequential fixed-size chunks. Default span is {@link DEFAULT_MAX_BLOCK_SPAN}
 * blocks; override via env `KOHAKU_GETLOGS_MAX_BLOCK_SPAN`.
 */
export function withChunkedGetLogs<T>(
  provider: EthereumProvider<T>
): EthereumProvider<T> {
  const chunkSpan = resolveMaxBlockSpan();
  const baseGetLogs = provider.getLogs.bind(provider);
  const baseRequest = provider.request.bind(provider);

  return {
    ...provider,
    getLogs: async (filter: Filter) => {
      const fromBn = filterBlockToBigInt(filter.fromBlock);
      const toBn = filterBlockToBigInt(filter.toBlock);
      if (fromBn === null || toBn === null || fromBn > toBn) {
        return baseGetLogs(filter);
      }

      const merged = await fetchLogsChunked(
        "getLogs",
        fromBn,
        toBn,
        chunkSpan,
        (from, to) =>
          baseGetLogs({
            ...filter,
            fromBlock: from,
            toBlock: to,
          })
      );
      return merged as Awaited<ReturnType<EthereumProvider<T>["getLogs"]>>;
    },

    request: async (req: Pick<RpcRequest, "method" | "params">) => {
      if (req.method !== "eth_getLogs") {
        return baseRequest(req);
      }
      const params = req.params;
      if (!Array.isArray(params) || params.length < 1) {
        return baseRequest(req);
      }
      const rawFilter = params[0];
      if (rawFilter === null || typeof rawFilter !== "object") {
        return baseRequest(req);
      }
      const filterObj = rawFilter as Record<string, unknown>;
      const fromBn = blockSpecToBigInt(filterObj.fromBlock);
      const toBn = blockSpecToBigInt(filterObj.toBlock);
      if (fromBn === null || toBn === null || fromBn > toBn) {
        return baseRequest(req);
      }

      return fetchLogsChunked(
        "request.eth_getLogs",
        fromBn,
        toBn,
        chunkSpan,
        (from, to) =>
          baseRequest({
            method: "eth_getLogs",
            params: [
              {
                ...filterObj,
                fromBlock: toRpcBlockQuantity(from),
                toBlock: toRpcBlockQuantity(to),
              },
            ],
          })
      );
    },
  };
}
