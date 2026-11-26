import { TorClient } from "tor-js/wasm-file";

export type FakeTorFetch = (url: string, init?: Parameters<TorClient["fetch"]>[1]) => Promise<Response>;

/** Replace bootstrap before construction, so tests never open real Tor sockets. */
export async function withFakeTor<T>(
  fetcher: FakeTorFetch,
  run: () => Promise<T>,
  ready: () => Promise<void> = async () => {},
): Promise<T> {
  const prototype = TorClient.prototype as unknown as { bootstrap: () => Promise<unknown> };
  const original = prototype.bootstrap;
  const originalReady = TorClient.prototype.ready;
  prototype.bootstrap = async () => ({ ready, fetch: fetcher, close: () => {} });
  // The dependency's ready() attaches an unhandled rejecting finally() when
  // bootstrap fails; replace that method too in deterministic failure tests.
  TorClient.prototype.ready = ready;
  try { return await run(); }
  finally { prototype.bootstrap = original; TorClient.prototype.ready = originalReady; }
}
