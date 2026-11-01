import chalk from "chalk";
import { existsSync, rmSync } from "node:fs";
import type { Command } from "commander";

import { cliOptions } from "../utils/cli-command-options.js";
import { logCliJson } from "../utils/cli-quiet.js";
import { DEFAULT_DATA_DIR } from "../utils/rpc.js";
import { clearPublicSyncCache } from "../utils/public-sync-cache.js";
import { syncCacheV2Dir } from "../utils/sync-cache-v2.js";
import { clearTorJsCache } from "../utils/tor.js";

type Opts = {
  nonInteractive?: boolean;
  publicSync?: boolean;
  dataDir?: string;
};

export function registerClearTorCacheCommand(program: Command): void {
  program
    .command("clear-tor-cache")
    .description(
      "Delete the on-disk tor-js cache (~/.local/share/tor-js); use after Tor bootstrap corruption errors"
    )
    .option("--non-interactive", cliOptions.nonInteractiveListWallets)
    .option(
      "--public-sync",
      "Also delete <dataDir>/sync-cache-v2 and any legacy public-sync-cache files"
    )
    .option("--dataDir <path>", cliOptions.dataDir)
    .action((opts: Opts) => {
      const tor = clearTorJsCache();
      const publicSync = opts.publicSync
        ? clearPublicSyncCache(opts.dataDir ?? DEFAULT_DATA_DIR)
        : undefined;
      const v2Path = syncCacheV2Dir(opts.dataDir ?? DEFAULT_DATA_DIR);
      const v2Cleared = !!opts.publicSync && existsSync(v2Path);
      if (v2Cleared) rmSync(v2Path, { recursive: true, force: true });
      if (opts.nonInteractive) {
        logCliJson({ ...tor, publicSync, syncCacheV2: opts.publicSync ? { path: v2Path, cleared: v2Cleared } : undefined });
        return;
      }
      console.log(
        tor.cleared
          ? chalk.green(`Cleared Tor cache: ${tor.path}`)
          : chalk.dim(`No Tor cache to clear (${tor.path})`)
      );
      if (publicSync) {
        console.log(v2Cleared
          ? chalk.green(`Cleared sync cache v2: ${v2Path}`)
          : chalk.dim(`No sync cache v2 to clear (${v2Path})`));
        console.log(
          publicSync.cleared
            ? chalk.green(
                `Cleared public sync cache: ${publicSync.path} (${publicSync.filesRemoved} file(s))`
              )
            : chalk.dim(`No public sync cache to clear (${publicSync.path})`)
        );
      }
    });
}
