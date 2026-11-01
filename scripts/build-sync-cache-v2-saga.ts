/**
 * Freeze mainnet Tornado and Privacy Pools Saga streams into a v2 snapshot.
 * Run with: npx tsx scripts/build-sync-cache-v2-saga.ts <output-dir> <release-id>
 * Rerun with the same output dir and release ID after an interrupted download.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { decodeAndVerify } from "@saga-sync/client";

import { parseSyncCacheV2Manifest, type SyncCacheV2File, type SyncCacheV2Manifest } from "../src/utils/sync-cache-v2.js";

type Segment = Parameters<typeof decodeAndVerify>[1];
type Stream = {
  chainId: string;
  protocol: string;
  extraLogFields?: "transactionHash"[];
  chunks: Segment[];
  hotHead?: Segment;
  [key: string]: unknown;
};
type SagaIndex = {
  version: number;
  updatedAt: string;
  compression: string;
  availableProtocols: Record<string, Stream>;
};

const origins = [
  { url: "https://saga.gordosoluciones.xyz", family: "tornado-cash" },
  { url: "https://saga-pp-state.global.ssl.fastly.net", family: "privacy-pools" },
];
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getBytes(url: string): Promise<Buffer> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 180_000);
      try {
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return Buffer.from(await response.arrayBuffer());
      } finally {
        clearTimeout(timer);
      }
    } catch (error) {
      lastError = error;
      if (attempt < 4) await delay(attempt * 1000);
    }
  }
  throw new Error(`Failed to fetch ${url}: ${String(lastError)}`);
}

async function main(): Promise<void> {
  const [outputArg, release] = process.argv.slice(2);
  if (!outputArg || !release || !/^[a-zA-Z0-9._-]+$/.test(release)) {
    throw new Error("Usage: npx tsx scripts/build-sync-cache-v2-saga.ts <output-dir> <release-id>");
  }
  const root = resolve(outputArg);
  const prefix = "saga";
  const files = new Map<string, SyncCacheV2File>();
  const frozen: SagaIndex = {
    version: 1,
    updatedAt: new Date().toISOString(),
    compression: "gzip",
    availableProtocols: {},
  };

  function write(relative: string, bytes: Uint8Array): void {
    const path = join(root, relative);
    mkdirSync(dirname(path), { recursive: true });
    if (existsSync(path) && sha256(readFileSync(path)) !== sha256(bytes)) {
      throw new Error(`Existing snapshot file differs: ${path}. Use a fresh output directory for a new snapshot.`);
    }
    if (!existsSync(path)) writeFileSync(path, bytes);
    files.set(relative, { path: relative, bytes: bytes.byteLength, sha256: sha256(bytes) });
  }

  for (const origin of origins) {
    console.error(`Loading ${origin.family} index from ${origin.url}`);
    const live = JSON.parse((await getBytes(`${origin.url}/index.json`)).toString("utf8")) as SagaIndex;
    if (live.compression !== "gzip" || !live.availableProtocols) throw new Error(`Unexpected Saga index at ${origin.url}`);
    const entries = Object.entries(live.availableProtocols)
      .filter(([, stream]) => stream.protocol === origin.family && BigInt(stream.chainId) === 1n)
      .sort(([a], [b]) => a.localeCompare(b));
    if (entries.length === 0) throw new Error(`No mainnet ${origin.family} streams at ${origin.url}`);
    for (const [id, stream] of entries) {
      if (frozen.availableProtocols[id]) throw new Error(`Duplicate Saga stream: ${id}`);
      const sourceSegments = [...(stream.chunks ?? []), ...(stream.hotHead ? [stream.hotHead] : [])];
      if (sourceSegments.length === 0) throw new Error(`Empty Saga stream: ${id}`);
      for (let i = 1; i < sourceSegments.length; i++) {
        if (BigInt(sourceSegments[i - 1]!.toBlock) !== BigInt(sourceSegments[i]!.fromBlock)) {
          throw new Error(`Noncontiguous Saga stream ${id}; refresh the publisher index and retry`);
        }
      }
      const chunks: Segment[] = [];
      for (const segment of sourceSegments) {
        const raw = await getBytes(`${origin.url}/${encodeURIComponent(segment.file)}`);
        await decodeAndVerify(raw, segment, { extraLogFields: stream.extraLogFields ?? [] });
        const name = `${sha256(raw)}.jsonl.gz`;
        write(`${prefix}/${name}`, raw);
        chunks.push({ ...segment, file: name });
        console.error(`  ${id} ${segment.fromBlock}..${segment.toBlock} ${Math.ceil(raw.length / 1024)} KiB`);
      }
      const { hotHead: _hotHead, ...metadata } = stream;
      frozen.availableProtocols[id] = { ...metadata, chunks } as Stream;
    }
    console.error(`Frozen ${entries.length} ${origin.family} streams`);
  }
  if (!Object.values(frozen.availableProtocols).some((entry) => entry.protocol === "privacy-pools") ||
      !Object.values(frozen.availableProtocols).some((entry) => entry.protocol === "tornado-cash")) {
    throw new Error("Release must include both Tornado and Privacy Pools");
  }
  write(`${prefix}/index.json`, Buffer.from(JSON.stringify(frozen, null, 2) + "\n"));
  const manifest: SyncCacheV2Manifest = {
    version: 2,
    createdAt: new Date().toISOString(),
    release,
    files: [...files.values()].sort((a, b) => a.path.localeCompare(b.path)),
    sources: { sagaMainnet: prefix },
  };
  const rawManifest = JSON.stringify(manifest, null, 2) + "\n";
  parseSyncCacheV2Manifest(rawManifest);
  writeFileSync(join(root, "manifest.json"), rawManifest);
  console.error(`Wrote ${manifest.files.length} verified files to ${root}. Build Railgun into the same release before publishing.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
