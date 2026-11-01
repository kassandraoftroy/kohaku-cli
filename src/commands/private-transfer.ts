import type { Command } from "commander";

import { runUnshield, type UnshieldOpts } from "./unshield.js";
import { cliOptions, passwordFileOption } from "../utils/cli-command-options";
import { SUPPORTED_PROTOCOLS_HELP } from "../utils/plugins";

export function runPrivateTransfer(opts: UnshieldOpts): Promise<void> {
  return runUnshield({ ...opts, privateTransfer: true });
}

export function registerPrivateTransferCommand(program: Command): void {
  program
    .command("private-transfer")
    .description(
      "Send an exact private amount (Railgun 0zk recipients stay inside Railgun)"
    )
    .option(
      "--protocol <protocol>",
      `Protocol: ${SUPPORTED_PROTOCOLS_HELP} (or set DEFAULT_PRIVACY_PROTOCOL)`
    )
    .option("--wallet <name>", cliOptions.walletPickList)
    .option("--password <password>", cliOptions.password)
    .addOption(passwordFileOption())
    .option(
      "--to <address>",
      "Final recipient: public address, Railgun 0zk address, stealth selector (s0), or name (.eth/.gwei/.wei)"
    )
    .option("--exclude-new-pools", "Tornado only: use classic pools; newer pools may have small anonymity sets")
    .option("--token <address|symbol|eth>", "Token address or symbol (default: eth)")
    .option("--amount-wei <amount>", "Exact amount the recipient receives, in wei/base units")
    .option(
      "--amount-formatted <amount>",
      "Exact amount the recipient receives (converted using token decimals)"
    )
    .option("--rpc-url <url>", cliOptions.rpcUrl)
    .option("--non-interactive", cliOptions.nonInteractiveShieldLike)
    .option(
      "--broadcast",
      "Submit via protocol broadcaster (omit to print the prepared private operation only)"
    )
    .option("--without-tor", cliOptions.withoutTor)
    .option("--dataDir <path>", cliOptions.dataDir)
    .action(runPrivateTransfer);
}
