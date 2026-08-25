import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { gzipSync } from "node:zlib";

import {
  cachePublicSyncNetworkResponse,
  countPublicSyncCacheEntries,
  DEFAULT_SYNC_CACHE_BASE_URL,
  installPublicSyncCacheArchive,
  installPublicSyncCacheChunk,
  isPublicSyncCacheableRequest,
  packPublicSyncCacheChunks,
  parseSyncCacheManifest,
  publicSyncCacheHasAllKeys,
  publicSyncCacheHasEntries,
  readPublicSyncCache,
  resolveSyncCacheBaseUrl,
  setPublicSyncCacheDataDir,
  SYNC_CACHE_MANIFEST_NAME,
  writePublicSyncCache,
  type SyncCacheManifest,
} from "../src/utils/public-sync-cache.js";

const MAINNET_SQUID =
  "https://rail-squid.squids.live/squid-railgun-ethereum-v2/v/v1/graphql";
const SEPOLIA_SQUID =
  "https://rail-squid.squids.live/squid-railgun-eth-sepolia-v2/v/v1/graphql";
const SAGA_URL = "https://saga.gordosoluciones.xyz/events.json";

const dirs: string[] = [];
const ORIG_BASE_URL = process.env.KOHAKU_SYNC_CACHE_BASE_URL;
const ORIG_MAX_BYTES = process.env.KOHAKU_PUBLIC_SYNC_CACHE_MAX_BYTES;

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "kohaku-public-sync-"));
  dirs.push(dir);
  return dir;
}

function gzipUstar(name: string, content: Buffer): Buffer {
  const header = Buffer.alloc(512);
  Buffer.from(name).copy(header, 0, 0, Math.min(name.length, 99));
  header.write("0000644\0", 100, 8, "utf8");
  header.write("0000000\0", 108, 8, "utf8");
  header.write("0000000\0", 116, 8, "utf8");
  header.write(
    `${content.length.toString(8).padStart(11, "0")}\0`,
    124,
    12,
    "utf8"
  );
  header.write("00000000000\0", 136, 12, "utf8");
  header.write("        ", 148, 8, "utf8");
  header[156] = 0x30;
  header.write("ustar\0", 257, 6, "utf8");
  header.write("00", 263, 2, "utf8");
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "utf8");
  const pad =
    content.length % 512 === 0 ? 0 : 512 - (content.length % 512);
  return gzipSync(
    Buffer.concat([header, content, Buffer.alloc(pad), Buffer.alloc(1024)])
  );
}

afterEach(() => {
  while (dirs.length) {
    const dir = dirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
  if (ORIG_BASE_URL === undefined) {
    delete process.env.KOHAKU_SYNC_CACHE_BASE_URL;
  } else {
    process.env.KOHAKU_SYNC_CACHE_BASE_URL = ORIG_BASE_URL;
  }
  if (ORIG_MAX_BYTES === undefined) {
    delete process.env.KOHAKU_PUBLIC_SYNC_CACHE_MAX_BYTES;
  } else {
    process.env.KOHAKU_PUBLIC_SYNC_CACHE_MAX_BYTES = ORIG_MAX_BYTES;
  }
});

function readManifest(outputDir: string): SyncCacheManifest {
  return parseSyncCacheManifest(
    readFileSync(join(outputDir, SYNC_CACHE_MANIFEST_NAME), "utf8")
  );
}

/** Install every chunk of a packed snapshot into `dataDir`. */
function installAllChunks(
  outputDir: string,
  manifest: SyncCacheManifest,
  dataDir: string
): number {
  let installed = 0;
  for (const chunk of manifest.chunks) {
    installed += installPublicSyncCacheChunk({
      dataDir,
      archivePath: join(outputDir, chunk.name),
      chunk,
    }).installed;
  }
  return installed;
}

describe("isPublicSyncCacheableRequest", () => {
  it("allows GET/POST Subsquid and saga URLs only", () => {
    assert.equal(
      isPublicSyncCacheableRequest(
        "https://rail-squid.squids.live/graphql",
        "POST"
      ),
      true
    );
    assert.equal(
      isPublicSyncCacheableRequest(
        "https://saga.gordosoluciones.xyz/events.json",
        "GET"
      ),
      true
    );
    assert.equal(
      isPublicSyncCacheableRequest("https://api.0xbow.io/pools", "GET"),
      false
    );
    assert.equal(
      isPublicSyncCacheableRequest("https://dw.0xbow.io/state", "POST"),
      false
    );
    assert.equal(
      isPublicSyncCacheableRequest("https://example.com/graphql", "POST"),
      false
    );
    assert.equal(
      isPublicSyncCacheableRequest("https://fastrelay.xyz/relayer", "POST"),
      false
    );
    assert.equal(
      isPublicSyncCacheableRequest(
        "https://rail-squid.squids.live/graphql",
        "PUT"
      ),
      false
    );
  });
});

describe("public sync HTTP cache", () => {
  it("hits after a 200 write and misses unknown keys", () => {
    const dataDir = tmp();
    setPublicSyncCacheDataDir(dataDir);
    const url = "https://rail-squid.squids.live/graphql";
    const body = '{"query":"{ ping }"}';
    assert.equal(
      readPublicSyncCache({ method: "POST", url, body }),
      null
    );
    writePublicSyncCache({
      method: "POST",
      url,
      body,
      responseBody: Buffer.from('{"data":{"ping":true}}'),
      contentType: "application/json",
    });
    const hit = readPublicSyncCache({ method: "POST", url, body });
    assert.ok(hit);
    assert.equal(hit.body.toString(), '{"data":{"ping":true}}');
    assert.equal(hit.contentType, "application/json");
    assert.equal(publicSyncCacheHasEntries(dataDir), true);
  });

  it("stops writing at the size ceiling without evicting existing entries", () => {
    const dataDir = tmp();
    setPublicSyncCacheDataDir(dataDir);
    process.env.KOHAKU_PUBLIC_SYNC_CACHE_MAX_BYTES = "4096";

    const first = '{"page":0}';
    writePublicSyncCache({
      method: "POST",
      url: MAINNET_SQUID,
      body: first,
      responseBody: randomBytes(3072),
      contentType: "application/json",
    });
    const stored = readPublicSyncCache({
      method: "POST",
      url: MAINNET_SQUID,
      body: first,
    });
    assert.ok(stored, "first entry should fit under the ceiling");

    // Now full: later pages are skipped rather than evicting the first.
    for (let i = 1; i < 4; i++) {
      const body = `{"page":${i}}`;
      writePublicSyncCache({
        method: "POST",
        url: MAINNET_SQUID,
        body,
        responseBody: randomBytes(3072),
      });
      assert.equal(
        readPublicSyncCache({ method: "POST", url: MAINNET_SQUID, body }),
        null,
        `page ${i} should not have been cached`
      );
    }

    const survivor = readPublicSyncCache({
      method: "POST",
      url: MAINNET_SQUID,
      body: first,
    });
    assert.ok(survivor, "existing entry must never be evicted");
    assert.equal(survivor.body.byteLength, 3072);
    assert.equal(countPublicSyncCacheEntries(dataDir), 1);
  });

  it("refreshes an existing key even when the cache is full", () => {
    const dataDir = tmp();
    setPublicSyncCacheDataDir(dataDir);
    process.env.KOHAKU_PUBLIC_SYNC_CACHE_MAX_BYTES = "4096";
    const body = '{"page":0}';
    writePublicSyncCache({
      method: "POST",
      url: MAINNET_SQUID,
      body,
      responseBody: Buffer.alloc(3072, 1),
    });
    // Same key, so its bytes are replaced rather than added to the total.
    writePublicSyncCache({
      method: "POST",
      url: MAINNET_SQUID,
      body,
      responseBody: Buffer.alloc(3072, 2),
    });
    const hit = readPublicSyncCache({
      method: "POST",
      url: MAINNET_SQUID,
      body,
    });
    assert.ok(hit);
    assert.equal(hit.body[0], 2);
    assert.equal(countPublicSyncCacheEntries(dataDir), 1);
  });

  it("does not cache non-200 responses", () => {
    const dataDir = tmp();
    setPublicSyncCacheDataDir(dataDir);
    const url = "https://saga.gordosoluciones.xyz/state.json";
    cachePublicSyncNetworkResponse({
      method: "GET",
      url,
      status: 500,
      responseBody: Buffer.from("nope"),
      contentType: "text/plain",
    });
    assert.equal(readPublicSyncCache({ method: "GET", url }), null);
    cachePublicSyncNetworkResponse({
      method: "GET",
      url,
      status: 200,
      responseBody: Buffer.from("ok"),
      contentType: "text/plain",
    });
    const hit = readPublicSyncCache({ method: "GET", url });
    assert.ok(hit);
    assert.equal(hit.body.toString(), "ok");
  });
});

describe("resolveSyncCacheBaseUrl", () => {
  it("uses the default base unless KOHAKU_SYNC_CACHE_BASE_URL is set", () => {
    delete process.env.KOHAKU_SYNC_CACHE_BASE_URL;
    assert.equal(resolveSyncCacheBaseUrl(), DEFAULT_SYNC_CACHE_BASE_URL);
    process.env.KOHAKU_SYNC_CACHE_BASE_URL = "https://example.test/snap/v2/";
    assert.equal(resolveSyncCacheBaseUrl(), "https://example.test/snap/v2");
  });
});

describe("pack/install public-sync chunks", () => {
  function seedThreeEntries(dataDir: string): void {
    setPublicSyncCacheDataDir(dataDir);
    writePublicSyncCache({
      method: "POST",
      url: MAINNET_SQUID,
      body: '{"query":"{ commitments }"}',
      responseBody: Buffer.from('{"data":{"commitments":[1]}}'),
      contentType: "application/json",
    });
    writePublicSyncCache({
      method: "POST",
      url: SEPOLIA_SQUID,
      body: "{}",
      responseBody: Buffer.from("sepolia-page"),
    });
    writePublicSyncCache({
      method: "GET",
      url: SAGA_URL,
      responseBody: Buffer.from('{"chunks":[]}'),
      contentType: "application/json",
    });
  }

  it("round-trips mixed-network cache entries through chunks", () => {
    const src = tmp();
    const dest = tmp();
    seedThreeEntries(src);

    const outputDir = tmp();
    const { manifest } = packPublicSyncCacheChunks({
      dataDir: src,
      outputDir,
    });
    assert.equal(manifest.version, 1);
    assert.equal(manifest.entries, 3);
    assert.ok(manifest.rawBytes > 0);
    assert.equal(existsSync(join(outputDir, SYNC_CACHE_MANIFEST_NAME)), true);
    for (const chunk of manifest.chunks) {
      assert.equal(existsSync(join(outputDir, chunk.name)), true);
      assert.match(chunk.name, /^chunk-\d{3}\.tar\.gz$/);
      assert.match(chunk.sha256, /^[a-f0-9]{64}$/);
    }
    const allKeys = manifest.chunks.flatMap((c) => c.keys);
    assert.equal(allKeys.length, 3);
    assert.equal(new Set(allKeys).size, 3);
    assert.deepEqual(readManifest(outputDir), manifest);

    assert.equal(installAllChunks(outputDir, manifest, dest), 3);
    setPublicSyncCacheDataDir(dest);
    const mainnet = readPublicSyncCache({
      method: "POST",
      url: MAINNET_SQUID,
      body: '{"query":"{ commitments }"}',
    });
    assert.ok(mainnet);
    assert.equal(mainnet.body.toString(), '{"data":{"commitments":[1]}}');
    assert.equal(mainnet.contentType, "application/json");
    const sepolia = readPublicSyncCache({
      method: "POST",
      url: SEPOLIA_SQUID,
      body: "{}",
    });
    assert.ok(sepolia);
    assert.equal(sepolia.body.toString(), "sepolia-page");
    const saga = readPublicSyncCache({ method: "GET", url: SAGA_URL });
    assert.ok(saga);
    assert.equal(saga.body.toString(), '{"chunks":[]}');
  });

  it("splits into multiple chunks and isolates oversized entries", () => {
    const src = tmp();
    setPublicSyncCacheDataDir(src);
    // Incompressible bodies, so each entry alone exceeds the 2 KiB target.
    for (let i = 0; i < 4; i++) {
      writePublicSyncCache({
        method: "POST",
        url: MAINNET_SQUID,
        body: `{"page":${i}}`,
        responseBody: randomBytes(4096),
      });
    }
    const outputDir = tmp();
    const { manifest } = packPublicSyncCacheChunks({
      dataDir: src,
      outputDir,
      chunkBytes: 2048,
    });
    assert.equal(manifest.entries, 4);
    assert.equal(manifest.chunks.length, 4);
    for (const chunk of manifest.chunks) {
      assert.equal(chunk.keys.length, 1);
    }

    const dest = tmp();
    assert.equal(installAllChunks(outputDir, manifest, dest), 4);
  });

  it("packs small entries together into one chunk", () => {
    const src = tmp();
    seedThreeEntries(src);
    const outputDir = tmp();
    const { manifest } = packPublicSyncCacheChunks({
      dataDir: src,
      outputDir,
    });
    assert.equal(manifest.chunks.length, 1);
    assert.equal(manifest.chunks[0]!.keys.length, 3);
  });

  it("rejects a chunk whose sha256 or size does not match the manifest", () => {
    const src = tmp();
    seedThreeEntries(src);
    const outputDir = tmp();
    const { manifest } = packPublicSyncCacheChunks({
      dataDir: src,
      outputDir,
    });
    const chunk = manifest.chunks[0]!;
    const archivePath = join(outputDir, chunk.name);

    assert.throws(
      () =>
        installPublicSyncCacheChunk({
          dataDir: tmp(),
          archivePath,
          chunk: { ...chunk, sha256: "b".repeat(64) },
        }),
      /sha256 mismatch/
    );
    assert.throws(
      () =>
        installPublicSyncCacheChunk({
          dataDir: tmp(),
          archivePath,
          chunk: { ...chunk, bytes: chunk.bytes + 1 },
        }),
      /size mismatch/
    );
  });

  it("reports whether all keys of a chunk are already cached", () => {
    const src = tmp();
    const dest = tmp();
    seedThreeEntries(src);
    const outputDir = tmp();
    const { manifest } = packPublicSyncCacheChunks({
      dataDir: src,
      outputDir,
    });
    const keys = manifest.chunks.flatMap((c) => c.keys);
    assert.equal(publicSyncCacheHasAllKeys(keys, dest), false);
    installAllChunks(outputDir, manifest, dest);
    assert.equal(publicSyncCacheHasAllKeys(keys, dest), true);
    assert.equal(publicSyncCacheHasAllKeys([...keys, "c".repeat(64)], dest), false);
  });

  it("installs only 64-hex cache files and ignores junk", () => {
    const dest = tmp();
    const staging = tmp();
    const key = "a".repeat(64);
    writeFileSync(join(staging, `${key}.bin`), "body");
    writeFileSync(
      join(staging, `${key}.json`),
      JSON.stringify({
        url: MAINNET_SQUID,
        method: "POST",
        contentType: "application/json",
        storedAt: new Date().toISOString(),
        bytes: 4,
      })
    );
    writeFileSync(join(staging, "README.txt"), "not a cache entry");
    writeFileSync(join(staging, "notes.bin"), "nope");
    const archivePath = join(tmp(), "mixed.tar.gz");
    const tar = spawnSync("tar", ["-czf", archivePath, "-C", staging, "."], {
      encoding: "utf8",
    });
    assert.equal(tar.status, 0, tar.stderr);

    const installed = installPublicSyncCacheArchive({
      dataDir: dest,
      archivePath,
    });
    assert.equal(installed.installed, 1);
    const names = readdirSync(installed.cacheDir).sort();
    assert.deepEqual(names, [`${key}.bin`, `${key}.json`]);
    assert.equal(existsSync(join(installed.cacheDir, "README.txt")), false);
  });

  it("refuses archive members with .. or absolute paths", () => {
    const dest = tmp();
    const archivePath = join(tmp(), "unsafe.tar.gz");
    writeFileSync(
      archivePath,
      gzipUstar("../" + "b".repeat(64) + ".bin", Buffer.from("x"))
    );
    assert.throws(
      () => installPublicSyncCacheArchive({ dataDir: dest, archivePath }),
      /unsafe path/
    );
  });

  it("throws when packing an empty cache", () => {
    const dataDir = tmp();
    assert.throws(
      () =>
        packPublicSyncCacheChunks({
          dataDir,
          outputDir: join(dataDir, "out"),
        }),
      /No public-sync-cache entries/
    );
  });
});

describe("parseSyncCacheManifest", () => {
  const chunk = {
    name: "chunk-000.tar.gz",
    bytes: 100,
    sha256: "a".repeat(64),
    keys: ["b".repeat(64)],
  };

  function manifest(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({ version: 1, chunks: [chunk], ...overrides });
  }

  it("accepts a well-formed manifest and defaults soft fields", () => {
    const parsed = parseSyncCacheManifest(manifest());
    assert.equal(parsed.version, 1);
    assert.equal(parsed.entries, 1);
    assert.equal(parsed.rawBytes, 0);
    assert.deepEqual(parsed.chunks, [chunk]);
  });

  it("rejects malformed JSON and non-objects", () => {
    assert.throws(() => parseSyncCacheManifest("{nope"), /not valid JSON/);
    assert.throws(() => parseSyncCacheManifest("null"), /must be a JSON object/);
  });

  it("rejects a manifest with no chunks", () => {
    assert.throws(
      () => parseSyncCacheManifest(manifest({ chunks: [] })),
      /no chunks/
    );
    assert.throws(
      () => parseSyncCacheManifest(manifest({ chunks: "nope" })),
      /no chunks/
    );
  });

  it("rejects an unsupported version", () => {
    assert.throws(
      () => parseSyncCacheManifest(manifest({ version: 2 })),
      /Unsupported sync-cache manifest version/
    );
  });

  it("rejects chunk names that could escape the output directory", () => {
    for (const name of [
      "../chunk-000.tar.gz",
      "/abs/chunk-000.tar.gz",
      "nested/chunk-000.tar.gz",
      "chunk-000.tar.gz.sh",
      "chunk-0.tar.gz",
    ]) {
      assert.throws(
        () => parseSyncCacheManifest(manifest({ chunks: [{ ...chunk, name }] })),
        /unsafe chunk name/,
        `expected ${name} to be rejected`
      );
    }
  });

  it("rejects missing or malformed integrity fields", () => {
    assert.throws(
      () =>
        parseSyncCacheManifest(
          manifest({ chunks: [{ ...chunk, sha256: "nope" }] })
        ),
      /no valid sha256/
    );
    assert.throws(
      () =>
        parseSyncCacheManifest(manifest({ chunks: [{ ...chunk, bytes: 0 }] })),
      /no valid byte size/
    );
    assert.throws(
      () => parseSyncCacheManifest(manifest({ chunks: [{ ...chunk, keys: [] }] })),
      /lists no cache keys/
    );
    assert.throws(
      () =>
        parseSyncCacheManifest(
          manifest({ chunks: [{ ...chunk, keys: ["../etc/passwd"] }] })
        ),
      /invalid cache key/
    );
  });

  it("rejects duplicate chunk names", () => {
    assert.throws(
      () => parseSyncCacheManifest(manifest({ chunks: [chunk, chunk] })),
      /Duplicate chunk/
    );
  });
});
