import type { Storage } from "@kohaku-eth/plugins";

const STATE_KEY = /^(?:sig:)?tornado-cash-state-\d+-\d+$/;

type Snapshot = Record<string, unknown>;
type NonceAllocation<T> = { value: T; nextNonce: number };
type Adapter = {
  storage: Storage;
  allocate<T>(key: string, run: (nextNonce: number) => Promise<NonceAllocation<T>>): Promise<T>;
};
const adapters = new WeakMap<Storage, Adapter>();

function validNonce(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function snapshot(value: string): Snapshot {
  let parsed: unknown;
  try { parsed = JSON.parse(value); }
  catch { throw new Error("Invalid Tornado signature nonce snapshot."); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid Tornado signature nonce snapshot.");
  }
  return parsed as Snapshot;
}

function nextNonce(state: Snapshot): number {
  if (state.signatureNonces === undefined) return 0;
  const reservations = state.signatureNonces;
  if (!reservations || typeof reservations !== "object" || Array.isArray(reservations) ||
    !validNonce((reservations as Record<string, unknown>).nextNonce)) {
    throw new Error("Invalid Tornado signature nonce reservation.");
  }
  return (reservations as { nextNonce: number }).nextNonce;
}

function withNextNonce(state: Snapshot, value: number): Snapshot {
  return { ...state, signatureNonces: { ...(state.signatureNonces as object | undefined), nextNonce: value } };
}

function adapterFor(underlying: Storage): Adapter {
  const cached = adapters.get(underlying);
  if (cached) return cached;
  const queues = new Map<string, Promise<unknown>>();
  const enqueue = <T>(key: string, run: () => Promise<T>): Promise<T> => {
    const result = (queues.get(key) ?? Promise.resolve()).then(run);
    // A failed write must not poison future reads or reservations.
    const tail = result.catch(() => {});
    queues.set(key, tail);
    void tail.then(() => { if (queues.get(key) === tail) queues.delete(key); });
    return result;
  };

  const storage: Storage = {
    _brand: "Storage",
    get: (key) => enqueue(key, () => underlying.get(key)),
    set: (key, value) => enqueue(key, async () => {
      if (!STATE_KEY.test(key)) return underlying.set(key, value);
      const incoming = snapshot(value);
      const incomingNext = nextNonce(incoming);
      const current = await underlying.get(key);
      const currentNext = current === null ? 0 : nextNonce(snapshot(current));
      // SDK workers may still hold a snapshot loaded before CLI allocation.
      // Preserve their newer public history while retaining every reservation.
      await underlying.set(key, currentNext > incomingNext
        ? JSON.stringify(withNextNonce(incoming, currentNext))
        : value);
    }),
  };
  const adapter: Adapter = {
    storage,
    allocate: (key, run) => enqueue(key, async () => {
      if (!STATE_KEY.test(key)) throw new Error("Invalid Tornado signature state key.");
      const raw = await underlying.get(key);
      if (raw === null) throw new Error("Cannot reserve Tornado signature nonces before syncing state.");
      const state = snapshot(raw);
      const start = nextNonce(state);
      const allocation = await run(start);
      if (!validNonce(allocation.nextNonce) || allocation.nextNonce < start) {
        throw new Error("Invalid Tornado signature nonce allocation.");
      }
      // Persist before releasing any commitments to the caller, including dry
      // runs and preparations that are later cancelled or only partly mined.
      if (allocation.nextNonce > start) {
        await underlying.set(key, JSON.stringify(withNextNonce(state, allocation.nextNonce)));
      }
      return allocation.value;
    }),
  };
  adapters.set(underlying, adapter);
  adapters.set(storage, adapter);
  return adapter;
}

/**
 * Retain alpha.39's SDK nonce reservation in its existing encrypted snapshot.
 * Cache this adapter on the shared wallet storage so SDK writes and CLI
 * allocations for the same state use one queue.
 */
export function tornadoSignatureNonceStorage(storage: Storage): Storage {
  return adapterFor(storage).storage;
}

/**
 * Allocate against the durable SDK high watermark and save the resulting one.
 * Sync before entering: `run` must not read/write this state key or invoke SDK
 * sync, since those operations use the same queue. Secret derivation is safe.
 */
export function withTornadoNonceReservation<T>(
  storage: Storage,
  stateKey: string,
  run: (nextNonce: number) => Promise<NonceAllocation<T>>,
): Promise<T> {
  return adapterFor(storage).allocate(stateKey, run);
}
