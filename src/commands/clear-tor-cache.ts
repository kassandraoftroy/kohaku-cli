import chalk from "chalk";
import type { Command } from "commander";

import { cliOptions } from "../utils/cli-command-options.js";
import { logCliJson } from "../utils/cli-quiet.js";
import { DEFAULT_DATA_DIR } from "../utils/rpc.js";
import { clearPublicSyncCache } from "../utils/public-sync-cache.js";
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
      "Also delete <dataDir>/public-sync-cache (Railgun Subsquid / Tornado saga HTTP cache)"
    )
    .option("--dataDir <path>", cliOptions.dataDir)
    .action((opts: Opts) => {
      const tor = clearTorJsCache();
      const publicSync = opts.publicSync
        ? clearPublicSyncCache(opts.dataDir ?? DEFAULT_DATA_DIR)
        : undefined;
      if (opts.nonInteractive) {
        logCliJson({ ...tor, publicSync });
        return;
      }
      console.log(
        tor.cleared
          ? chalk.green(`Cleared Tor cache: ${tor.path}`)
          : chalk.dim(`No Tor cache to clear (${tor.path})`)
      );
      if (publicSync) {
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
