import chalk from "chalk";
import type { Command } from "commander";

import { cliOptions } from "../utils/cli-command-options.js";
import { cliErrorFromCaught } from "../utils/cli-errors.js";
import { logCliJson } from "../utils/cli-quiet.js";
import { setPublicSyncCacheDataDir } from "../utils/public-sync-cache.js";
import { DEFAULT_DATA_DIR } from "../utils/rpc.js";
import {
  downloadSyncCacheV2File,
  installSyncCacheV2Manifest,
  parseSyncCacheV2Manifest,
  syncCacheV2BaseUrl,
  syncCacheV2Dir,
  type SyncCacheV2Manifest,
} from "../utils/sync-cache-v2.js";
import { ensureKohakuFetchPatch, withTor } from "../utils/tor.js";

const MANIFEST_TIMEOUT_MS = 60_000;
const FILE_ATTEMPTS = 3;
const DOWNLOAD_CONCURRENCY = 4;

type Opts = {
  force?: boolean;
  withoutTor?: boolean;
  dataDir?: string;
  nonInteractive?: boolean;
};

function formatMib(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

async function downloadManifest(): Promise<{ raw: string; manifest: SyncCacheV2Manifest }> {
  const url = `${syncCacheV2BaseUrl()}/manifest.json`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MANIFEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > 2 * 1024 * 1024) {
      throw new Error("Manifest exceeds 2 MiB");
    }
    if (!response.body) throw new Error("Manifest has no body");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 2 * 1024 * 1024) throw new Error("Manifest exceeds 2 MiB");
      chunks.push(value);
    }
    const raw = Buffer.concat(chunks).toString("utf8");
    return { raw, manifest: parseSyncCacheV2Manifest(raw) };
  } catch (error) {
    throw new Error(`Sync-cache v2 manifest fetch failed from ${url}: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timer);
  }
}

export function registerFetchSyncCacheCommand(program: Command): void {
  program
    .command("fetch-sync-cache")
    .description("Download and verify the mainnet protocol sync snapshot in <dataDir>/sync-cache-v2")
    .option("--force", "Re-download files already present in the local cache")
    .option("--without-tor", cliOptions.withoutTorSyncCacheFetch)
    .option("--dataDir <path>", cliOptions.dataDir)
    .option("--non-interactive", cliOptions.nonInteractiveListWallets)
    .action(async (opts: Opts) => {
      try {
        const dataDir = opts.dataDir ?? DEFAULT_DATA_DIR;
        setPublicSyncCacheDataDir(dataDir);
        ensureKohakuFetchPatch();
        const useTor = !opts.withoutTor;
        const cacheDir = syncCacheV2Dir(dataDir);
        if (!opts.nonInteractive) {
          console.error(chalk.dim(`Sync cache: ${cacheDir}\nBase URL: ${syncCacheV2BaseUrl()}\nRoute: ${useTor ? "Tor" : "clearnet (--without-tor)"}`));
        }

        const result = await withTor(useTor, {
          onStatus: opts.nonInteractive ? undefined : (message) => console.error(chalk.dim(message)),
        }, async () => {
          const { raw, manifest } = await downloadManifest();
          if (!manifest.sources.sagaMainnet || !manifest.sources.railgunMainnet) {
            throw new Error("Sync-cache v2 release is incomplete: mainnet Saga and Railgun sources are both required");
          }
          const totalBytes = manifest.files.reduce((sum, file) => sum + file.bytes, 0);
          let completedBytes = 0;
          let transferredBytes = 0;
          let installed = 0;
          let skipped = 0;
          const started = Date.now();
          if (!opts.nonInteractive) {
            console.error(chalk.dim(`Release ${manifest.release}: ${manifest.files.length} files, ${formatMib(totalBytes)}`));
          }
          let next = 0;
          let completed = 0;
          const failures: string[] = [];
          const worker = async () => {
            while (next < manifest.files.length) {
              const file = manifest.files[next++]!;
              let status: "installed" | "skipped" | "failed" = "failed";
              for (let attempt = 1; attempt <= FILE_ATTEMPTS; attempt++) {
                try {
                  status = await downloadSyncCacheV2File(file, { dataDir, force: opts.force });
                  break;
                } catch (error) {
                  if (attempt === FILE_ATTEMPTS) {
                    failures.push(`${file.path}: ${error instanceof Error ? error.message : String(error)}`);
                  } else {
                    await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
                  }
                }
              }
              if (status === "installed") {
                installed++;
                transferredBytes += file.bytes;
              }
              if (status === "skipped") skipped++;
              completed++;
              if (status !== "failed") completedBytes += file.bytes;
              if (!opts.nonInteractive) {
                const elapsed = (Date.now() - started) / 1000;
                const etaMinutes = elapsed > 5 && transferredBytes > 1024 * 1024 && completedBytes < totalBytes
                  ? Math.ceil(elapsed * (totalBytes - completedBytes) / transferredBytes / 60)
                  : null;
                const eta = etaMinutes === null ? "" : ` · ~${etaMinutes}m remaining`;
                console.error(chalk.dim(`[${completed}/${manifest.files.length}] ${Math.round(100 * completedBytes / totalBytes)}% · ${formatMib(completedBytes)} / ${formatMib(totalBytes)} · ${status}${eta}`));
              }
            }
          };
          await Promise.all(Array.from({ length: Math.min(DOWNLOAD_CONCURRENCY, manifest.files.length) }, () => worker()));
          if (failures.length > 0) throw new Error(`${failures.length} sync-cache v2 file(s) failed; rerun to resume. First failure: ${failures[0]}`);
          installSyncCacheV2Manifest(raw, dataDir);
          return { cacheDir, release: manifest.release, files: manifest.files.length, installed, skipped, bytes: totalBytes, via: useTor ? "tor" : "clearnet" };
        });
        if (opts.nonInteractive) logCliJson(result);
        else console.log(chalk.green(`Sync cache v2 ready: release ${result.release}, ${result.files} verified files (${formatMib(result.bytes)}).`));
      } catch (error) {
        cliErrorFromCaught(error);
        process.exitCode = 1;
      }
    });
}
