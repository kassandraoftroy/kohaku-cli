import chalk from "chalk";
import type { Command } from "commander";

import { cliOptions } from "../utils/cli-command-options.js";
import { logCliJson } from "../utils/cli-quiet.js";
import { clearTorJsCache } from "../utils/tor.js";

type Opts = {
  nonInteractive?: boolean;
};

export function registerClearTorCacheCommand(program: Command): void {
  program
    .command("clear-tor-cache")
    .description(
      "Delete the on-disk tor-js cache (~/.local/share/tor-js); use after Tor bootstrap corruption errors"
    )
    .option("--non-interactive", cliOptions.nonInteractiveListWallets)
    .action((opts: Opts) => {
      const result = clearTorJsCache();
      if (opts.nonInteractive) {
        logCliJson(result);
        return;
      }
      console.log(
        result.cleared
          ? chalk.green(`Cleared Tor cache: ${result.path}`)
          : chalk.dim(`No Tor cache to clear (${result.path})`)
      );
    });
}
