import type { Command } from "commander";

import { cliOptions } from "../utils/cli-command-options.js";
import { DEFAULT_DATA_DIR } from "../utils/rpc.js";

type TuiOpts = {
  wallet?: string;
  password?: string;
  rpcUrl?: string;
  dataDir?: string;
  withoutTor?: boolean;
};

export function registerTuiCommand(program: Command): void {
  program
    .command("tui")
    .description(
      "Interactive terminal UI: wallet session with balances, shield, and unshield flows"
    )
    .option("--wallet <name>", cliOptions.walletPickList)
    .option("--password <password>", cliOptions.password)
    .option("--rpc-url <url>", cliOptions.rpcUrl)
    .option("--without-tor", cliOptions.withoutTor)
    .option("--dataDir <path>", cliOptions.dataDir)
    .action(async (opts: TuiOpts) => {
      const { runTui } = await import("../tui/run.js");
      await runTui({
        dataDir: opts.dataDir ?? DEFAULT_DATA_DIR,
        wallet: opts.wallet,
        password: opts.password,
        rpcUrl: opts.rpcUrl,
        withoutTor: opts.withoutTor,
      });
    });
}
