import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import chalk from "chalk";
import type { Command } from "commander";

import { cliOptions } from "../utils/cli-command-options.js";
import { cliErrorFromCaught } from "../utils/cli-errors.js";
import { logCliJson } from "../utils/cli-quiet.js";
import {
  countPublicSyncCacheEntries,
  DEFAULT_CHUNK_BYTES,
  installPublicSyncCacheChunk,
  packPublicSyncCacheChunks,
  parseSyncCacheManifest,
  publicSyncCacheDir,
  publicSyncCacheHasAllKeys,
  resolveSyncCacheBaseUrl,
  resolveSyncCacheChunkTimeoutMs,
  setPublicSyncCacheDataDir,
  syncCacheChunkUrl,
  syncCacheManifestUrl,
  type SyncCacheChunk,
  type SyncCacheManifest,
} from "../utils/public-sync-cache.js";
import { DEFAULT_DATA_DIR } from "../utils/rpc.js";
import { ensureKohakuFetchPatch, withTor } from "../utils/tor.js";

const MANIFEST_TIMEOUT_MS = 60_000;
const CHUNK_ATTEMPTS = 3;

type Opts = {
  pack?: string;
  chunkBytes?: string;
  force?: boolean;
  withoutTor?: boolean;
  dataDir?: string;
  nonInteractive?: boolean;
};

type ChunkOutcome = {
  name: string;
  status: "installed" | "skipped" | "failed";
  installed: number;
  error?: string;
};

function formatMib(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function parseChunkBytes(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_CHUNK_BYTES;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1024) {
    throw new Error(
      `--chunk-bytes must be an integer of at least 1024 (got ${JSON.stringify(raw)})`
    );
  }
  return n;
}

/**
 * The chunk URLs sit outside the proving-artifact routing, so `kohakuFetch`
 * applies no timeout of its own and this budget is the only bound.
 */
async function fetchWithTimeout(
  url: string,
  timeoutMs: number
): Promise<Buffer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  } catch (e) {
    if (controller.signal.aborted) {
      throw new Error(`timed out after ${timeoutMs}ms`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function downloadManifest(
  nonInteractive: boolean
): Promise<SyncCacheManifest> {
  const url = syncCacheManifestUrl();
  if (!nonInteractive) {
    console.error(chalk.dim(`Manifest: ${url}`));
  }
  let raw: Buffer;
  try {
    raw = await fetchWithTimeout(url, MANIFEST_TIMEOUT_MS);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    throw new Error(
      `Sync-cache manifest fetch failed (${message}) from ${url}. Override the location with KOHAKU_SYNC_CACHE_BASE_URL.`
    );
  }
  return parseSyncCacheManifest(raw.toString("utf8"));
}

async function installChunk(opts: {
  chunk: SyncCacheChunk;
  dataDir: string;
  tmpRoot: string;
  timeoutMs: number;
}): Promise<number> {
  const { chunk, dataDir, tmpRoot, timeoutMs } = opts;
  const url = syncCacheChunkUrl(chunk.name);
  const archivePath = join(tmpRoot, chunk.name);
  let lastError = "";

  for (let attempt = 1; attempt <= CHUNK_ATTEMPTS; attempt++) {
    try {
      writeFileSync(archivePath, await fetchWithTimeout(url, timeoutMs));
      const { installed } = installPublicSyncCacheChunk({
        dataDir,
        archivePath,
        chunk,
      });
      return installed;
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      if (attempt < CHUNK_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, 1000 * attempt));
      }
    } finally {
      rmSync(archivePath, { force: true });
    }
  }
  throw new Error(lastError);
}

async function downloadChunks(opts: {
  manifest: SyncCacheManifest;
  dataDir: string;
  force: boolean;
  nonInteractive: boolean;
}): Promise<ChunkOutcome[]> {
  const { manifest, dataDir, force, nonInteractive } = opts;
  const timeoutMs = resolveSyncCacheChunkTimeoutMs();
  const tmpRoot = mkdtempSync(join(tmpdir(), "kohaku-sync-cache-"));
  const outcomes: ChunkOutcome[] = [];
  const total = manifest.chunks.length;

  try {
    for (let i = 0; i < total; i++) {
      const chunk = manifest.chunks[i]!;
      const label = `[${i + 1}/${total}] ${chunk.name}`;

      if (!force && publicSyncCacheHasAllKeys(chunk.keys, dataDir)) {
        outcomes.push({ name: chunk.name, status: "skipped", installed: 0 });
        if (!nonInteractive) {
          console.error(chalk.dim(`${label} skip (${chunk.keys.length} entries cached)`));
        }
        continue;
      }

      if (!nonInteractive) {
        console.error(chalk.dim(`${label} fetch ${formatMib(chunk.bytes)}`));
      }
      try {
        const installed = await installChunk({
          chunk,
          dataDir,
          tmpRoot,
          timeoutMs,
        });
        outcomes.push({ name: chunk.name, status: "installed", installed });
        if (!nonInteractive) {
          console.error(chalk.dim(`  ok (${installed} entries)`));
        }
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        outcomes.push({ name: chunk.name, status: "failed", installed: 0, error });
        if (!nonInteractive) {
          console.error(chalk.red(`  failed: ${error}`));
        }
      }
    }
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
  return outcomes;
}

export function registerFetchSyncCacheCommand(program: Command): void {
  program
    .command("fetch-sync-cache")
    .description(
      "Download the public-sync snapshot in verifiable chunks into <dataDir>/public-sync-cache (or --pack a new one)"
    )
    .option(
      "--pack <dir>",
      "Publisher mode: pack <dataDir>/public-sync-cache into chunk-NNN.tar.gz + manifest.json in <dir>"
    )
    .option(
      "--chunk-bytes <n>",
      `Target compressed bytes per chunk with --pack (default: ${DEFAULT_CHUNK_BYTES})`
    )
    .option(
      "--force",
      "Re-download chunks whose entries are already present in the local cache"
    )
    .option("--without-tor", cliOptions.withoutTorSyncCacheFetch)
    .option("--dataDir <path>", cliOptions.dataDir)
    .option("--non-interactive", cliOptions.nonInteractiveListWallets)
    .action(async (opts: Opts) => {
      try {
        const dataDir = opts.dataDir ?? DEFAULT_DATA_DIR;
        setPublicSyncCacheDataDir(dataDir);
        ensureKohakuFetchPatch();

        if (opts.pack) {
          const { outputDir, manifest } = packPublicSyncCacheChunks({
            dataDir,
            outputDir: resolve(opts.pack),
            chunkBytes: parseChunkBytes(opts.chunkBytes),
          });
          const packedBytes = manifest.chunks.reduce((n, c) => n + c.bytes, 0);
          if (opts.nonInteractive) {
            logCliJson({ packed: true, outputDir, manifest });
          } else {
            console.log(
              chalk.green(
                `Packed ${manifest.entries} entries into ${manifest.chunks.length} chunks (${formatMib(packedBytes)} from ${formatMib(manifest.rawBytes)} raw)`
              )
            );
            console.log(chalk.dim(`Output: ${outputDir}`));
            console.log(
              chalk.dim(
                `Publish these files (including manifest.json) at ${resolveSyncCacheBaseUrl()}/`
              )
            );
          }
          return;
        }

        const useTor = !opts.withoutTor;
        const cacheDir = publicSyncCacheDir(dataDir);
        if (!opts.nonInteractive) {
          console.error(
            chalk.dim(
              `Public-sync cache: ${cacheDir}\nBase URL: ${resolveSyncCacheBaseUrl()}\nRoute: ${useTor ? "Tor" : "clearnet (--without-tor)"}`
            )
          );
        }

        const outcomes = await withTor(
          useTor,
          {
            onStatus: opts.nonInteractive
              ? undefined
              : (m) => console.error(chalk.dim(m)),
          },
          async () => {
            const manifest = await downloadManifest(!!opts.nonInteractive);
            if (!opts.nonInteractive) {
              console.error(
                chalk.dim(
                  `Snapshot: ${manifest.entries} entries in ${manifest.chunks.length} chunks`
                )
              );
            }
            return downloadChunks({
              manifest,
              dataDir,
              force: !!opts.force,
              nonInteractive: !!opts.nonInteractive,
            });
          }
        );

        const installed = outcomes.filter((o) => o.status === "installed");
        const skipped = outcomes.filter((o) => o.status === "skipped");
        const failed = outcomes.filter((o) => o.status === "failed");
        const entriesInstalled = installed.reduce((n, o) => n + o.installed, 0);
        const result = {
          cacheDir,
          baseUrl: resolveSyncCacheBaseUrl(),
          via: useTor ? ("tor" as const) : ("clearnet" as const),
          chunks: outcomes.length,
          chunksInstalled: installed.length,
          chunksSkipped: skipped.length,
          chunksFailed: failed.length,
          entriesInstalled,
          entries: countPublicSyncCacheEntries(dataDir),
          errors: failed.map((o) => ({ chunk: o.name, error: o.error ?? "" })),
        };

        if (opts.nonInteractive) {
          logCliJson(result);
        } else {
          console.log(
            chalk.green(
              `Sync cache: ${entriesInstalled} entries from ${installed.length} chunks, ${skipped.length} chunks already present, ${failed.length} failed`
            )
          );
          console.log(
            chalk.dim(`Cache: ${cacheDir} (${result.entries} entries total)`)
          );
          if (failed.length > 0) {
            console.log(
              chalk.yellow(
                "Partial snapshot installed. Re-run to retry the failed chunks; anything still missing is fetched live during sync."
              )
            );
          }
        }

        if (failed.length > 0) {
          process.exitCode = 1;
        }
      } catch (e) {
        cliErrorFromCaught(e);
        process.exitCode = 1;
      }
    });
}
