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
import { DEFAULT_DATA_DIR } from "../utils/rpc.js";
import { ensureKohakuFetchPatch, withTor } from "../utils/tor.js";

type Opts = {
  variant?: string[];
  poi?: string[];
  tornado?: boolean;
  withoutTor?: boolean;
  dataDir?: string;
  nonInteractive?: boolean;
};

export function registerFetchArtifactsCommand(program: Command): void {
  program
    .command("fetch-artifacts")
    .description(
      "Download proving artifacts into the local cache (default: full set over Tor)"
    )
    .argument(
      "[keys...]",
      "Optional relative keys (e.g. railgun/01x03/proving_key.bin.br). Omit with no filters = full set."
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
    .option("--without-tor", cliOptions.withoutTorArtifactsFetch)
    .option("--dataDir <path>", cliOptions.dataDir)
    .option("--non-interactive", cliOptions.nonInteractiveListWallets)
    .action(async (keys: string[], opts: Opts) => {
      try {
        const dataDir = opts.dataDir ?? DEFAULT_DATA_DIR;
        setArtifactsDataDir(dataDir);
        ensureKohakuFetchPatch();

        const selected = parseFetchArtifactSelection({
          keys,
          variants: opts.variant,
          poi: opts.poi,
          tornado: opts.tornado,
        });
        const cacheDir = provingArtifactsDir(dataDir);
        const baseUrl = resolveArtifactsBaseUrl();
        const useTor = !opts.withoutTor;
        const fullSet =
          selected.length === listAllArtifactRelativeKeys().length;

        if (!opts.nonInteractive) {
          console.error(
            chalk.dim(
              `Artifact cache: ${cacheDir}\nBase URL: ${baseUrl}\nRoute: ${useTor ? "Tor" : "clearnet (--without-tor)"}\nFiles: ${selected.length}${fullSet ? " (full set)" : ""}`
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

        const result = await withTor(
          useTor,
          {
            onStatus: opts.nonInteractive
              ? undefined
              : (m) => console.error(chalk.dim(m)),
          },
          async () => {
            let downloaded = 0;
            let skipped = 0;
            let failed = 0;
            const errors: Array<{ key: string; error: string }> = [];

            for (let i = 0; i < selected.length; i++) {
              const key = selected[i]!;
              if (cachedArtifactExists(dataDir, key)) {
                skipped++;
                if (!opts.nonInteractive) {
                  console.error(
                    chalk.dim(
                      `[${i + 1}/${selected.length}] skip (cached) ${key}`
                    )
                  );
                }
                continue;
              }

              const url = remoteUrlForArtifactKey(key);
              if (!opts.nonInteractive) {
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
                if (!cachedArtifactExists(dataDir, key)) {
                  throw new Error("download completed but cache file missing");
                }
                downloaded++;
              } catch (e) {
                failed++;
                const message = e instanceof Error ? e.message : String(e);
                errors.push({ key, error: message });
                if (!opts.nonInteractive) {
                  console.error(chalk.red(`  failed: ${message}`));
                }
              }
            }

            return {
              cacheDir,
              baseUrl,
              via: useTor ? ("tor" as const) : ("clearnet" as const),
              total: selected.length,
              downloaded,
              skipped,
              failed,
              errors,
            };
          }
        );

        if (opts.nonInteractive) {
          logCliJson(result);
        } else {
          console.log(
            chalk.green(
              `Artifacts: ${result.downloaded} downloaded, ${result.skipped} already cached, ${result.failed} failed (${result.total} total)`
            )
          );
          console.log(chalk.dim(`Cache: ${result.cacheDir}`));
        }

        if (result.failed > 0) {
          process.exitCode = 1;
        }
      } catch (e) {
        cliErrorFromCaught(e);
        process.exitCode = 1;
      }
    });
}
