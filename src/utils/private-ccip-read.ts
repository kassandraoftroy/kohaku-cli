import { isHex, type CcipRequestParameters, type Hex } from "viem";
import { kohakuPrivateFetch } from "./tor.js";

/** ENSIP-21 / EIP-3668 gateways never inherit the chain RPC's clearnet allowlist. */
export async function privateCcipRequest({ data, sender, urls, requestOptions }: CcipRequestParameters): Promise<Hex> {
  for (const template of urls) {
    requestOptions?.signal?.throwIfAborted();
    try {
      const url = template.replaceAll("{sender}", sender.toLowerCase()).replaceAll("{data}", data);
      if (!["http:", "https:"].includes(new URL(url).protocol)) continue;
      const method = template.includes("{data}") ? "GET" : "POST";
      const response = await kohakuPrivateFetch(url, {
        method,
        ...(method === "POST" ? {
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ data, sender }),
        } : {}),
        signal: requestOptions?.signal,
      });
      if (!response.ok) continue;
      const result: unknown = response.headers.get("content-type")?.startsWith("application/json")
        ? (await response.json() as { data?: unknown }).data
        : await response.text();
      if (typeof result === "string" && isHex(result, { strict: true }) && result.length % 2 === 0) return result;
    } catch {
      requestOptions?.signal?.throwIfAborted();
      // Try the next advertised gateway using the same privacy policy.
    }
  }
  throw new Error("Offchain name lookup failed; no gateway returned valid data over the selected network route.");
}
