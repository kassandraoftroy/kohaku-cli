import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { gzipSync } from "node:zlib";

import {
  cachePublicSyncNetworkResponse,
  DEFAULT_PUBLIC_SYNC_SNAPSHOT_URL,
  installPublicSyncCacheArchive,
  isPublicSyncCacheableRequest,
  packPublicSyncCacheArchive,
  publicSyncCacheHasEntries,
  readPublicSyncCache,
  resolvePublicSyncSnapshotUrl,
  setPublicSyncCacheDataDir,
  writePublicSyncCache,
} from "../src/utils/public-sync-cache.js";

const MAINNET_SQUID =
  "https://rail-squid.squids.live/squid-railgun-ethereum-v2/v/v1/graphql";
const SEPOLIA_SQUID =
  "https://rail-squid.squids.live/squid-railgun-eth-sepolia-v2/v/v1/graphql";
const SAGA_URL = "https://saga.gordosoluciones.xyz/events.json";

const dirs: string[] = [];
const ORIG_SNAPSHOT_URL = process.env.KOHAKU_PUBLIC_SYNC_SNAPSHOT_URL;

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
  if (ORIG_SNAPSHOT_URL === undefined) {
    delete process.env.KOHAKU_PUBLIC_SYNC_SNAPSHOT_URL;
  } else {
    process.env.KOHAKU_PUBLIC_SYNC_SNAPSHOT_URL = ORIG_SNAPSHOT_URL;
  }
});

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

describe("resolvePublicSyncSnapshotUrl", () => {
  it("uses the dummy file URL unless KOHAKU_PUBLIC_SYNC_SNAPSHOT_URL is set", () => {
    delete process.env.KOHAKU_PUBLIC_SYNC_SNAPSHOT_URL;
    assert.equal(
      resolvePublicSyncSnapshotUrl(),
      DEFAULT_PUBLIC_SYNC_SNAPSHOT_URL
    );
    process.env.KOHAKU_PUBLIC_SYNC_SNAPSHOT_URL =
      "https://example.test/public-sync-cache.tar.gz/";
    assert.equal(
      resolvePublicSyncSnapshotUrl(),
      "https://example.test/public-sync-cache.tar.gz"
    );
  });
});

describe("pack/install public-sync snapshots", () => {
  it("round-trips mixed-network cache entries through a tarball", () => {
    const src = tmp();
    const dest = tmp();
    setPublicSyncCacheDataDir(src);
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
    const archivePath = join(tmp(), "public-sync-cache.tar.gz");
    const packed = packPublicSyncCacheArchive({
      dataDir: src,
      outputPath: archivePath,
    });
    assert.equal(packed.entries, 3);
    assert.equal(existsSync(archivePath), true);

    const installed = installPublicSyncCacheArchive({
      dataDir: dest,
      archivePath,
    });
    assert.equal(installed.installed, 3);
    setPublicSyncCacheDataDir(dest);
    const mainnet = readPublicSyncCache({
      method: "POST",
      url: MAINNET_SQUID,
      body: '{"query":"{ commitments }"}',
    });
    assert.ok(mainnet);
    assert.equal(mainnet.body.toString(), '{"data":{"commitments":[1]}}');
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
        packPublicSyncCacheArchive({
          dataDir,
          outputPath: join(dataDir, "empty.tar.gz"),
        }),
      /No public-sync-cache entries/
    );
  });
});
