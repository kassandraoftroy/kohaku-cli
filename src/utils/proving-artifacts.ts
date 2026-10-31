/**
 * Proving circuits for Railgun, Tornado, and Privacy Pools.
 *
 * The bytes live in the installed `kohaku-artifacts` package. WASM and plugins
 * request pinned GitHub or the CLI mirror URLs; {@link kohakuFetch} maps those
 * onto this package and does not download them.
 * Privacy Pools paths are `<package>/artifacts/privacy-pools/<path after packages/circuits/>`.
 */
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";

/** Mirror host. Requests here are served from the package, not fetched. */
export const DEFAULT_ARTIFACTS_BASE_URL = "https://artifacts.0000000000.org";

/** Legacy Railgun artifact source, retained for older requests and tests. */
const MACWHA_ARTIFACTS_BASE =
  "https://github.com/Robert-MacWha/privacy-protocol-artifacts/raw/refs/heads/main/artifacts";
const MACWHA_ARTIFACTS_PREFIX = `${MACWHA_ARTIFACTS_BASE}/`;

const TORNADO_CIRCUIT_URL =
  "https://raw.githubusercontent.com/tornadocash/tornado-cli/refs/heads/master/build/circuits/tornado.json";
const TORNADO_PROVING_KEY_URL =
  "https://raw.githubusercontent.com/tornadocash/tornado-cli/refs/heads/master/build/circuits/tornadoProvingKey.bin";

/** Paths relative to `packages/circuits/` for the two circuits the SDK loads. */
export const PRIVACY_POOLS_CIRCUIT_PATHS = [
  "build/commitment/commitment_js/commitment.wasm",
  "build/withdraw/withdraw_js/withdraw.wasm",
  "trusted-setup/final-keys/commitment.vkey",
  "trusted-setup/final-keys/commitment.zkey",
  "trusted-setup/final-keys/withdraw.vkey",
  "trusted-setup/final-keys/withdraw.zkey",
] as const;

export const PRIVACY_POOLS_ARTIFACT_KEYS = PRIVACY_POOLS_CIRCUIT_PATHS.map(
  (path) => `privacy-pools/${path}`
);

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
  keys.push(...PRIVACY_POOLS_ARTIFACT_KEYS);
  return keys;
}

/**
 * `raw.githubusercontent.com/0xbow-io/privacy-pools-core/<rev>/packages/circuits/<rel>`
 * → `privacy-pools/<rel>`. The commit is ignored so an SDK pin bump still reads the package.
 */
function privacyPoolsArtifactKeyFromUrl(urlStr: string): string | null {
  let url: URL;
  try {
    url = new URL(urlStr);
  } catch {
    return null;
  }
  if (url.hostname.toLowerCase() !== "raw.githubusercontent.com") return null;
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 6) return null;
  if (parts[0] !== "0xbow-io" || parts[1] !== "privacy-pools-core") return null;
  if (parts[3] !== "packages" || parts[4] !== "circuits") return null;
  const relParts = parts.slice(5).map((part) => {
    try {
      return decodeURIComponent(part);
    } catch {
      return part;
    }
  });
  if (
    relParts.some(
      (part) => !part || part === "." || part === ".." || part.includes("\\")
    )
  ) {
    return null;
  }
  return `privacy-pools/${relParts.join("/")}`;
}

/**
 * Public-sync snapshot chunks share the artifacts host but are not circuits.
 * Treating them as proving artifacts would reject the snapshot download.
 */
function isSyncCacheRelativeKey(relativeKey: string): boolean {
  return (
    relativeKey.startsWith("sync-cache/") ||
    relativeKey === "public-sync-cache.tar.gz"
  );
}

/**
 * Map an SDK request URL onto a path under `kohaku-artifacts/artifacts`.
 * Returns null when the URL is not a proving circuit (including sync snapshots
 * on the same host).
 */
export function artifactRelativeKeyFromUrl(urlStr: string): string | null {
  try {
    const url = new URL(urlStr);
    const href = url.href;

    const mirrorPrefix = `${DEFAULT_ARTIFACTS_BASE_URL}/`;
    if (href.startsWith(MACWHA_ARTIFACTS_PREFIX) || href.startsWith(mirrorPrefix)) {
      const prefix = href.startsWith(MACWHA_ARTIFACTS_PREFIX)
        ? MACWHA_ARTIFACTS_PREFIX
        : mirrorPrefix;
      const rest = href.slice(prefix.length).replace(/^\/+/, "");
      if (!rest || isSyncCacheRelativeKey(rest)) return null;
      return rest;
    }

    if (href === TORNADO_CIRCUIT_URL) return "tornado/tornado.json";
    if (href === TORNADO_PROVING_KEY_URL) return "tornado/tornadoProvingKey.bin";

    const privacyPoolsKey = privacyPoolsArtifactKeyFromUrl(href);
    if (privacyPoolsKey) return privacyPoolsKey;

    return null;
  } catch {
    return null;
  }
}

const packagedRequire = createRequire(import.meta.url);

function safeRelativeArtifactKey(relativeKey: string): string | null {
  if (!relativeKey || relativeKey.includes("\0") || relativeKey.includes("..")) {
    return null;
  }
  const trimmed = relativeKey.replace(/^\/+/, "");
  if (!trimmed || trimmed.startsWith("/") || trimmed.includes("\\")) return null;
  return trimmed;
}

/** `node_modules/kohaku-artifacts/artifacts`, when that package is installed. */
export function packagedArtifactsDir(): string | null {
  try {
    const pkgJson = packagedRequire.resolve("kohaku-artifacts/package.json");
    return join(dirname(pkgJson), "artifacts");
  } catch {
    return null;
  }
}

function packagedArtifactPath(relativeKey: string): string | null {
  const key = safeRelativeArtifactKey(relativeKey);
  const root = packagedArtifactsDir();
  if (!key || !root) return null;
  const path = join(root, key);
  const rootPrefix = root.endsWith(sep) ? root : `${root}${sep}`;
  if (path !== root && !path.startsWith(rootPrefix)) return null;
  return path;
}

/** Bytes from the installed kohaku-artifacts package. Does not touch the network. */
export function readPackagedArtifact(relativeKey: string): Buffer | null {
  const path = packagedArtifactPath(relativeKey);
  if (!path || !existsSync(path)) return null;
  return readFileSync(path);
}

function missingArtifact(relativeKey: string): Error {
  return new Error(
    `Proving artifact ${relativeKey} is not in the kohaku-artifacts package. Reinstall kohaku-cli.`
  );
}

export function readPackagedArtifactOrThrow(relativeKey: string): Buffer {
  const body = readPackagedArtifact(relativeKey);
  if (!body) throw missingArtifact(relativeKey);
  return body;
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

/**
 * Tornado `artifactsLoader`. Reads the two files from kohaku-artifacts.
 */
export function makeTornadoArtifactsLoader(): () => Promise<{
  circuitText: string;
  provingKey: ArrayBuffer;
}> {
  return async () => {
    const circuitBuf = readPackagedArtifactOrThrow("tornado/tornado.json");
    const provingBuf = readPackagedArtifactOrThrow("tornado/tornadoProvingKey.bin");
    const provingCopy = Uint8Array.from(provingBuf);
    return {
      circuitText: circuitBuf.toString("utf8"),
      provingKey: provingCopy.buffer as ArrayBuffer,
    };
  };
}
