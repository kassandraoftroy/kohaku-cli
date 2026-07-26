/**
 * Route Pimlico bundler HTTP through Tor via a localhost reverse proxy.
 *
 * Tornado prepare/estimate runs inside a worker thread that cannot see a
 * main-process `fetch` monkey-patch, and Railgun's WASM bundler also uses
 * `fetch` against the configured bundler URL. Pointing that URL at a
 * 127.0.0.1 proxy whose upstream is tor-js covers every path.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { TorClient } from "tor-js/wasm-file";

const PIMLICO_ORIGIN = "https://public.pimlico.io";
const ALLOWED_PATH = /^\/v2\/\d+\/rpc$/;

type ActiveProxy = {
  baseUrl: string;
  close: () => Promise<void>;
};

let activeProxy: ActiveProxy | null = null;

/** Railgun + Tornado talk to public Pimlico; Privacy Pools uses fastrelay. */
export function protocolUsesPimlicoBundler(protocol: string): boolean {
  return protocol === "railgun" || protocol === "tornado";
}

/**
 * Bundler JSON-RPC URL for the given chain. When a Tor proxy session is
 * active, returns the local proxy URL so all clients (main + workers) stay
 * off the clearnet path to Pimlico.
 */
export function resolvePimlicoBundlerUrl(chainId: bigint): string {
  const path = `/v2/${chainId.toString()}/rpc`;
  if (activeProxy) {
    return `${activeProxy.baseUrl}${path}`;
  }
  return `${PIMLICO_ORIGIN}${path}`;
}

function readRequestBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer | string) => {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function sendProxyError(
  res: http.ServerResponse,
  status: number,
  message: string
): void {
  if (res.headersSent) return;
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { message } }));
}

async function startLocalProxy(client: TorClient): Promise<{
  baseUrl: string;
  server: http.Server;
}> {
  const server = http.createServer((req, res) => {
    void (async () => {
      try {
        if (req.method !== "POST") {
          sendProxyError(res, 405, "Method not allowed");
          return;
        }
        const path = req.url?.split("?")[0] ?? "";
        if (!ALLOWED_PATH.test(path)) {
          sendProxyError(res, 404, "Not found");
          return;
        }

        const body = await readRequestBody(req);
        const upstream = `${PIMLICO_ORIGIN}${path}`;
        const torRes = await client.fetch(upstream, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
        });

        const responseBody = Buffer.from(await torRes.arrayBuffer());
        const contentType =
          torRes.headers.get("content-type") ?? "application/json";
        res.writeHead(torRes.status, { "content-type": contentType });
        res.end(responseBody);
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Tor proxy request failed";
        sendProxyError(res, 502, message);
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const addr = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    server,
  };
}

export type WithPimlicoTorOptions = {
  onStatus?: (message: string) => void;
};

/**
 * When `enabled`, bootstraps Tor and installs a localhost Pimlico proxy for
 * the duration of `fn`. Nested calls reuse the same session.
 */
export async function withPimlicoTor<T>(
  enabled: boolean,
  opts: WithPimlicoTorOptions,
  fn: () => Promise<T>
): Promise<T> {
  if (!enabled) {
    return fn();
  }
  if (activeProxy) {
    return fn();
  }

  opts.onStatus?.("Starting Tor for Pimlico requests…");
  const client = process.env.KOHAKU_TOR_DEBUG
    ? new TorClient({ logLevel: "info" })
    : new TorClient();

  try {
    await client.ready();
    opts.onStatus?.("Tor ready; proxying Pimlico via localhost…");
    const { baseUrl, server } = await startLocalProxy(client);

    let closed = false;
    const close = async () => {
      if (closed) return;
      closed = true;
      if (activeProxy?.baseUrl === baseUrl) {
        activeProxy = null;
      }
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      client.close();
    };

    activeProxy = { baseUrl, close };

    try {
      return await fn();
    } finally {
      await close();
    }
  } catch (err) {
    client.close();
    throw err;
  }
}
