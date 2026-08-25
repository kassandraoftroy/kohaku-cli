/**
 * On-disk proving-artifact cache for Railgun (MacWha path layout) and Tornado.
 *
 * WASM / plugins still request GitHub URLs; {@link kohakuFetch} maps those to
 * this cache and, on miss, fetches from {@link resolveArtifactsBaseUrl}.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Keep local — avoid importing `rpc.ts` (circular with tor → proving-artifacts). */
function defaultDataDir(): string {
  return join(homedir(), ".kohaku-cli");
}

/** Tor-friendly static mirror (Cloudflare R2 custom domain). */
export const DEFAULT_ARTIFACTS_BASE_URL = "https://artifacts.0000000000.org";

/** Hardcoded in `@kohaku-eth/railgun` WASM — still intercepted for cache keys. */
const MACWHA_ARTIFACTS_BASE =
  "https://github.com/Robert-MacWha/privacy-protocol-artifacts/raw/refs/heads/main/artifacts";
const MACWHA_ARTIFACTS_PREFIX = `${MACWHA_ARTIFACTS_BASE}/`;

const TORNADO_CIRCUIT_URL =
  "https://raw.githubusercontent.com/tornadocash/tornado-cli/refs/heads/master/build/circuits/tornado.json";
const TORNADO_PROVING_KEY_URL =
  "https://raw.githubusercontent.com/tornadocash/tornado-cli/refs/heads/master/build/circuits/tornadoProvingKey.bin";

const RAILGUN_FILE_NAMES = [
  "proving_key.bin.br",
  "matrices.bin.br",
  "wasm.br",
] as const;

/** Transact grid `01x01` … `05x05`. */
export function railgunTransactVariants(): string[] {
  const out: string[] = [];
  for (let n = 1; n <= 5; n++) {
    for (let m = 1; m <= 5; m++) {
      out.push(
        `${String(n).padStart(2, "0")}x${String(m).padStart(2, "0")}`
      );
    }
  }
  return out;
}

export const RAILGUN_POI_VARIANTS = ["03x03", "13x13"] as const;

export function normalizeArtifactsBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, "");
}

export function resolveArtifactsBaseUrl(): string {
  const fromEnv = process.env.KOHAKU_ARTIFACTS_BASE_URL?.trim();
  if (fromEnv) return normalizeArtifactsBaseUrl(fromEnv);
  return DEFAULT_ARTIFACTS_BASE_URL;
}

function isMacWhaArtifactsBase(base: string): boolean {
  return normalizeArtifactsBaseUrl(base) === MACWHA_ARTIFACTS_BASE;
}

export function provingArtifactsDir(dataDir: string = defaultDataDir()): string {
  return join(dataDir, "proving-artifacts");
}

export function artifactFilePath(dataDir: string, relativeKey: string): string {
  return join(provingArtifactsDir(dataDir), relativeKey);
}

export function listAllArtifactRelativeKeys(): string[] {
  const keys: string[] = [];
  for (const variant of railgunTransactVariants()) {
    for (const file of RAILGUN_FILE_NAMES) {
      keys.push(`railgun/${variant}/${file}`);
    }
  }
  for (const variant of RAILGUN_POI_VARIANTS) {
    for (const file of RAILGUN_FILE_NAMES) {
      keys.push(`railgun/poi/${variant}/${file}`);
    }
  }
  keys.push("tornado/tornado.json", "tornado/tornadoProvingKey.bin");
  return keys;
}

const VARIANT_RE = /^\d{2}x\d{2}$/;

function normalizeVariantId(raw: string, kind: "variant" | "poi"): string {
  const v = raw.trim().toLowerCase();
  if (!VARIANT_RE.test(v)) {
    throw new Error(
      `Invalid --${kind} ${JSON.stringify(raw)}; expected form NNxMM (e.g. 01x03)`
    );
  }
  if (kind === "variant" && !railgunTransactVariants().includes(v)) {
    throw new Error(`Unknown Railgun transact variant ${v} (use 01x01…05x05)`);
  }
  if (
    kind === "poi" &&
    !(RAILGUN_POI_VARIANTS as readonly string[]).includes(v)
  ) {
    throw new Error(`Unknown Railgun POI variant ${v} (use 03x03 or 13x13)`);
  }
  return v;
}

function keysForRailgunVariant(variant: string): string[] {
  return RAILGUN_FILE_NAMES.map((f) => `railgun/${variant}/${f}`);
}

function keysForPoiVariant(variant: string): string[] {
  return RAILGUN_FILE_NAMES.map((f) => `railgun/poi/${variant}/${f}`);
}

/**
 * Resolve which artifact keys to download for `fetch-artifacts`.
 * With no filters / keys → full set. Otherwise union of selections.
 */
export function parseFetchArtifactSelection(opts: {
  keys?: string[];
  variants?: string[];
  poi?: string[];
  tornado?: boolean;
}): string[] {
  const keys = (opts.keys ?? []).map((k) => k.trim()).filter(Boolean);
  const variants = opts.variants ?? [];
  const poi = opts.poi ?? [];
  const wantsTornado = !!opts.tornado;

  if (
    keys.length === 0 &&
    variants.length === 0 &&
    poi.length === 0 &&
    !wantsTornado
  ) {
    return listAllArtifactRelativeKeys();
  }

  const known = new Set(listAllArtifactRelativeKeys());
  const out = new Set<string>();

  for (const key of keys) {
    const normalized = key.replace(/^\/+/, "");
    if (!known.has(normalized)) {
      throw new Error(
        `Unknown artifact key ${JSON.stringify(normalized)}. Example: railgun/01x03/proving_key.bin.br`
      );
    }
    out.add(normalized);
  }
  for (const raw of variants) {
    const v = normalizeVariantId(raw, "variant");
    for (const k of keysForRailgunVariant(v)) out.add(k);
  }
  for (const raw of poi) {
    const v = normalizeVariantId(raw, "poi");
    for (const k of keysForPoiVariant(v)) out.add(k);
  }
  if (wantsTornado) {
    out.add("tornado/tornado.json");
    out.add("tornado/tornadoProvingKey.bin");
  }

  return [...out].sort();
}

/**
 * Public-sync snapshot chunks are published under the artifacts base but are
 * not proving artifacts. Routing them through the artifact path would apply the
 * Tor CDN hard timeout, duplicate every chunk into `proving-artifacts`, and pin
 * later runs to the first snapshot ever fetched.
 */
function isSyncCacheRelativeKey(relativeKey: string): boolean {
  return (
    relativeKey.startsWith("sync-cache/") ||
    relativeKey === "public-sync-cache.tar.gz"
  );
}

/**
 * Map a plugin/WASM request URL to a cache-relative key, or null if not an
 * artifact we manage.
 */
export function artifactRelativeKeyFromUrl(urlStr: string): string | null {
  try {
    const url = new URL(urlStr);
    const href = url.href;

    if (href.startsWith(MACWHA_ARTIFACTS_PREFIX)) {
      const rest = href.slice(MACWHA_ARTIFACTS_PREFIX.length).replace(/^\/+/, "");
      if (!rest || isSyncCacheRelativeKey(rest)) return null;
      return rest;
    }

    const base = resolveArtifactsBaseUrl();
    const basePrefix = `${base}/`;
    if (href.startsWith(basePrefix)) {
      const rest = href.slice(basePrefix.length).replace(/^\/+/, "");
      if (!rest || isSyncCacheRelativeKey(rest)) return null;
      return rest;
    }

    if (href === TORNADO_CIRCUIT_URL || href.endsWith("/tornado.json")) {
      return "tornado/tornado.json";
    }
    if (
      href === TORNADO_PROVING_KEY_URL ||
      href.endsWith("/tornadoProvingKey.bin")
    ) {
      return "tornado/tornadoProvingKey.bin";
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Remote URL to fetch for a cache key. Default mirror hosts Railgun + Tornado
 * under the same base. If someone points `KOHAKU_ARTIFACTS_BASE_URL` at MacWha
 * GitHub, Tornado still comes from tornadocash (MacWha has no `tornado/` tree).
 */
export function remoteUrlForArtifactKey(relativeKey: string): string {
  const base = resolveArtifactsBaseUrl();
  if (relativeKey === "tornado/tornado.json" && isMacWhaArtifactsBase(base)) {
    return TORNADO_CIRCUIT_URL;
  }
  if (
    relativeKey === "tornado/tornadoProvingKey.bin" &&
    isMacWhaArtifactsBase(base)
  ) {
    return TORNADO_PROVING_KEY_URL;
  }
  return `${base}/${relativeKey}`;
}

export function readCachedArtifact(
  dataDir: string,
  relativeKey: string
): Buffer | null {
  const path = artifactFilePath(dataDir, relativeKey);
  if (!existsSync(path)) return null;
  return readFileSync(path);
}

export function writeCachedArtifact(
  dataDir: string,
  relativeKey: string,
  body: Uint8Array
): string {
  const path = artifactFilePath(dataDir, relativeKey);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
  return path;
}

export function cachedArtifactExists(
  dataDir: string,
  relativeKey: string
): boolean {
  return existsSync(artifactFilePath(dataDir, relativeKey));
}

/** Data dir used by the global fetch patch for artifact cache hits/misses. */
let activeArtifactsDataDir: string = defaultDataDir();

export function getArtifactsDataDir(): string {
  return activeArtifactsDataDir;
}

export function setArtifactsDataDir(dataDir: string): void {
  activeArtifactsDataDir = dataDir;
}

export function buildLocalArtifactResponse(
  requestUrl: string,
  body: Uint8Array
): Response {
  const copy = Uint8Array.from(body);
  const headers = new Headers({
    "content-type": "application/octet-stream",
    "content-length": String(copy.byteLength),
  });
  const res = new Response(copy, { status: 200, statusText: "OK", headers });
  try {
    Object.defineProperty(res, "url", {
      value: requestUrl,
      configurable: true,
      enumerable: true,
    });
  } catch {
    // ignore
  }
  return res;
}

export const TORNADO_ARTIFACT_KEYS = [
  "tornado/tornado.json",
  "tornado/tornadoProvingKey.bin",
] as const;

/**
 * Tornado `artifactsLoader`: serve from disk cache (caller / fetch patch should
 * have populated files). Falls back to fetch of known URLs so first use still
 * works through {@link kohakuFetch}.
 */
export function makeTornadoArtifactsLoader(dataDir?: string): () => Promise<{
  circuitText: string;
  provingKey: ArrayBuffer;
}> {
  const dir = dataDir ?? getArtifactsDataDir();
  return async () => {
    const circuitKey = "tornado/tornado.json";
    const provingKeyKey = "tornado/tornadoProvingKey.bin";

    let circuitBuf = readCachedArtifact(dir, circuitKey);
    let provingBuf = readCachedArtifact(dir, provingKeyKey);

    if (!circuitBuf || !provingBuf) {
      const [circuitRes, provingRes] = await Promise.all([
        fetch(remoteUrlForArtifactKey(circuitKey)),
        fetch(remoteUrlForArtifactKey(provingKeyKey)),
      ]);
      if (!circuitRes.ok) {
        throw new Error(
          `Tornado circuit download failed (${circuitRes.status}). Try: kohaku fetch-artifacts`
        );
      }
      if (!provingRes.ok) {
        throw new Error(
          `Tornado proving key download failed (${provingRes.status}). Try: kohaku fetch-artifacts`
        );
      }
      circuitBuf = Buffer.from(await circuitRes.arrayBuffer());
      provingBuf = Buffer.from(await provingRes.arrayBuffer());
      writeCachedArtifact(dir, circuitKey, circuitBuf);
      writeCachedArtifact(dir, provingKeyKey, provingBuf);
    }

    const provingCopy = Uint8Array.from(provingBuf);
    return {
      circuitText: circuitBuf.toString("utf8"),
      provingKey: provingCopy.buffer as ArrayBuffer,
    };
  };
}
