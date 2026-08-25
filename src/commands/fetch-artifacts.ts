import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import chalk from "chalk";
import type { Command } from "commander";

import { cliOptions } from "../utils/cli-command-options.js";
import { cliErrorFromCaught } from "../utils/cli-errors.js";
import { logCliJson } from "../utils/cli-quiet.js";
import {
  cachedArtifactExists,
  listAllArtifactRelativeKeys,
  parseFetchArtifactSelection,
  provingArtifactsDir,
  remoteUrlForArtifactKey,
  resolveArtifactsBaseUrl,
  setArtifactsDataDir,
} from "../utils/proving-artifacts.js";
import {
  countPublicSyncCacheEntries,
  installPublicSyncCacheArchive,
  packPublicSyncCacheArchive,
  publicSyncCacheDir,
  resolvePublicSyncSnapshotUrl,
  setPublicSyncCacheDataDir,
} from "../utils/public-sync-cache.js";
import { DEFAULT_DATA_DIR } from "../utils/rpc.js";
import { ensureKohakuFetchPatch, withTor } from "../utils/tor.js";

type Opts = {
  variant?: string[];
  poi?: string[];
  tornado?: boolean;
  withoutTor?: boolean;
  dataDir?: string;
  nonInteractive?: boolean;
  publicSync?: boolean;
  packPublicSync?: string;
};

type ProvingFetchResult = {
  cacheDir: string;
  baseUrl: string;
  via: "tor" | "clearnet";
  total: number;
  downloaded: number;
  skipped: number;
  failed: number;
  errors: Array<{ key: string; error: string }>;
};

type PublicSyncSnapshotResult = {
  url: string;
  installed: number;
  cacheDir: string;
  entries: number;
  via: "tor" | "clearnet";
  skipped?: boolean;
  error?: string;
};

function hasProvingSelectors(keys: string[], opts: Opts): boolean {
  return (
    keys.length > 0 ||
    (opts.variant?.length ?? 0) > 0 ||
    (opts.poi?.length ?? 0) > 0 ||
    !!opts.tornado
  );
}

async function downloadProvingArtifacts(opts: {
  dataDir: string;
  selected: string[];
  nonInteractive: boolean;
  useTor: boolean;
}): Promise<ProvingFetchResult> {
  const cacheDir = provingArtifactsDir(opts.dataDir);
  const baseUrl = resolveArtifactsBaseUrl();
  const { selected, nonInteractive } = opts;
  let downloaded = 0;
  let skipped = 0;
  let failed = 0;
  const errors: Array<{ key: string; error: string }> = [];

  for (let i = 0; i < selected.length; i++) {
    const key = selected[i]!;
    if (cachedArtifactExists(opts.dataDir, key)) {
      skipped++;
      if (!nonInteractive) {
        console.error(
          chalk.dim(`[${i + 1}/${selected.length}] skip (cached) ${key}`)
        );
      }
      continue;
    }

    const url = remoteUrlForArtifactKey(key);
    if (!nonInteractive) {
      console.error(
        chalk.dim(`[${i + 1}/${selected.length}] fetch ${key}`)
      );
    }
    try {
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      await res.arrayBuffer();
      if (!cachedArtifactExists(opts.dataDir, key)) {
        throw new Error("download completed but cache file missing");
      }
      downloaded++;
    } catch (e) {
      failed++;
      const message = e instanceof Error ? e.message : String(e);
      errors.push({ key, error: message });
      if (!nonInteractive) {
        console.error(chalk.red(`  failed: ${message}`));
      }
    }
  }

  return {
    cacheDir,
    baseUrl,
    via: opts.useTor ? ("tor" as const) : ("clearnet" as const),
    total: selected.length,
    downloaded,
    skipped,
    failed,
    errors,
  };
}

async function downloadPublicSyncSnapshot(opts: {
  dataDir: string;
  nonInteractive: boolean;
  useTor: boolean;
}): Promise<PublicSyncSnapshotResult> {
  setPublicSyncCacheDataDir(opts.dataDir);
  const url = resolvePublicSyncSnapshotUrl();
  const tmpRoot = mkdtempSync(join(tmpdir(), "kohaku-public-sync-snap-"));
  try {
    if (!opts.nonInteractive) {
      console.error(chalk.dim(`Public-sync snapshot: ${url}`));
    }
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(
        `Public-sync snapshot failed: HTTP ${res.status} from ${url}. Override with KOHAKU_PUBLIC_SYNC_SNAPSHOT_URL.`
      );
    }
    const archivePath = join(tmpRoot, "public-sync-cache.tar.gz");
    writeFileSync(archivePath, Buffer.from(await res.arrayBuffer()));
    const { installed, cacheDir } = installPublicSyncCacheArchive({
      dataDir: opts.dataDir,
      archivePath,
    });
    return {
      url,
      installed,
      cacheDir,
      entries: countPublicSyncCacheEntries(opts.dataDir),
      via: opts.useTor ? ("tor" as const) : ("clearnet" as const),
    };
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
}

export function registerFetchArtifactsCommand(program: Command): void {
  program
    .command("fetch-artifacts")
    .description(
      "Download proving artifacts and/or a public-sync snapshot into the local cache (no filters = both)"
    )
    .argument(
      "[keys...]",
      "Optional relative keys (e.g. railgun/01x03/proving_key.bin.br). Omit with no filters = full proving set + public-sync snapshot."
    )
    .option(
      "--variant <NxM>",
      "Railgun transact variant(s), e.g. 01x03 (repeatable)",
      (value: string, prev: string[]) => [...prev, value],
      [] as string[]
    )
    .option(
      "--poi <NxM>",
      "Railgun POI variant(s), e.g. 03x03 or 13x13 (repeatable)",
      (value: string, prev: string[]) => [...prev, value],
      [] as string[]
    )
    .option("--tornado", "Fetch Tornado circuit JSON + proving key only")
    .option(
      "--public-sync",
      "Download public-sync-cache.tar.gz into <dataDir>/public-sync-cache (implied by a no-filter fetch; alone: snapshot only; with proving filters: both)"
    )
    .option(
      "--pack-public-sync <file>",
      "Pack the local public-sync-cache into a .tar.gz (after you have synced once). Incompatible with --public-sync"
    )
    .option("--without-tor", cliOptions.withoutTorArtifactsFetch)
    .option("--dataDir <path>", cliOptions.dataDir)
    .option("--non-interactive", cliOptions.nonInteractiveListWallets)
    .action(async (keys: string[], opts: Opts) => {
      try {
        const dataDir = opts.dataDir ?? DEFAULT_DATA_DIR;
        setArtifactsDataDir(dataDir);
        setPublicSyncCacheDataDir(dataDir);
        ensureKohakuFetchPatch();

        if (opts.packPublicSync && opts.publicSync) {
          throw new Error(
            "Use either --pack-public-sync (create a snapshot) or --public-sync (download one), not both"
          );
        }

        if (opts.packPublicSync) {
          const packed = packPublicSyncCacheArchive({
            dataDir,
            outputPath: resolve(opts.packPublicSync),
          });
          if (opts.nonInteractive) {
            logCliJson({ packed: true, ...packed });
          } else {
            console.log(
              chalk.green(
                `Packed ${packed.entries} public-sync-cache entries`
              )
            );
            console.log(chalk.dim(`Archive: ${packed.outputPath}`));
          }
          return;
        }

        const provingSelected = hasProvingSelectors(keys, opts);
        const wantsSnapshot = !!opts.publicSync || !provingSelected;
        const wantsProving = !opts.publicSync || provingSelected;

        const selected = wantsProving
          ? parseFetchArtifactSelection({
              keys,
              variants: opts.variant,
              poi: opts.poi,
              tornado: opts.tornado,
            })
          : [];
        const provingCacheDir = provingArtifactsDir(dataDir);
        const baseUrl = resolveArtifactsBaseUrl();
        const useTor = !opts.withoutTor;
        const fullSet =
          wantsProving &&
          selected.length === listAllArtifactRelativeKeys().length;

        if (!opts.nonInteractive) {
          if (wantsProving) {
            console.error(
              chalk.dim(
                `Artifact cache: ${provingCacheDir}\nBase URL: ${baseUrl}\nRoute: ${useTor ? "Tor" : "clearnet (--without-tor)"}\nFiles: ${selected.length}${fullSet ? " (full set)" : ""}`
              )
            );
            if (!useTor) {
              console.error(
                chalk.yellow(
                  "Clearnet pre-warm: this IP will be seen downloading kohaku proving artifacts. Later shield/unshield use the local cache and stay Tor-only (except RPC)."
                )
              );
            }
          }
          if (wantsSnapshot) {
            console.error(
              chalk.dim(
                `Public-sync cache: ${publicSyncCacheDir(dataDir)}\nSnapshot: ${resolvePublicSyncSnapshotUrl()}\nRoute: ${useTor ? "Tor" : "clearnet (--without-tor)"}`
              )
            );
          }
        }

        const result = await withTor(
          useTor,
          {
            onStatus: opts.nonInteractive
              ? undefined
              : (m) => console.error(chalk.dim(m)),
          },
          async () => {
            let publicSync: PublicSyncSnapshotResult | undefined;
            if (wantsSnapshot) {
              try {
                publicSync = await downloadPublicSyncSnapshot({
                  dataDir,
                  nonInteractive: !!opts.nonInteractive,
                  useTor,
                });
              } catch (e) {
                if (opts.publicSync) throw e;
                const message = e instanceof Error ? e.message : String(e);
                if (!opts.nonInteractive) {
                  console.error(
                    chalk.yellow(
                      `Public-sync snapshot skipped: ${message}`
                    )
                  );
                }
                publicSync = {
                  url: resolvePublicSyncSnapshotUrl(),
                  installed: 0,
                  cacheDir: publicSyncCacheDir(dataDir),
                  entries: countPublicSyncCacheEntries(dataDir),
                  via: useTor ? ("tor" as const) : ("clearnet" as const),
                  skipped: true,
                  error: message,
                };
              }
            }
            const proving = wantsProving
              ? await downloadProvingArtifacts({
                  dataDir,
                  selected,
                  nonInteractive: !!opts.nonInteractive,
                  useTor,
                })
              : undefined;
            return { proving, publicSync };
          }
        );

        if (opts.nonInteractive) {
          if (result.proving && result.publicSync) {
            logCliJson({ ...result.proving, publicSync: result.publicSync });
          } else if (result.publicSync) {
            logCliJson({ publicSync: true, ...result.publicSync });
          } else {
            logCliJson(result.proving);
          }
        } else {
          if (result.publicSync && !result.publicSync.skipped) {
            console.log(
              chalk.green(
                `Public-sync snapshot: ${result.publicSync.installed} entries installed (${result.publicSync.entries} total in cache)`
              )
            );
            console.log(chalk.dim(`Cache: ${result.publicSync.cacheDir}`));
          }
          if (result.proving) {
            console.log(
              chalk.green(
                `Artifacts: ${result.proving.downloaded} downloaded, ${result.proving.skipped} already cached, ${result.proving.failed} failed (${result.proving.total} total)`
              )
            );
            console.log(chalk.dim(`Cache: ${result.proving.cacheDir}`));
          }
        }

        if ((result.proving?.failed ?? 0) > 0) {
          process.exitCode = 1;
        }
      } catch (e) {
        cliErrorFromCaught(e);
        process.exitCode = 1;
      }
    });
}
