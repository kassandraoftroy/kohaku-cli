import type { Command } from "commander";
import { readActivity } from "../utils/activity-log.js";
import { cliOptions, passwordFileOption } from "../utils/cli-command-options.js";
import { cliErrorFromCaught } from "../utils/cli-errors.js";
import { readSeedKeystore } from "../utils/mnemonic.js";
import { DEFAULT_DATA_DIR } from "../utils/rpc.js";
import { resolveWalletDir, resolveWalletNameOrPrompt, resolveWalletPassword } from "../utils/wallets-util.js";

export function registerActivityCommand(program: Command): void {
  program.command("activity")
    .description("Show this wallet's encrypted local CLI transaction history (newest first; no RPC required)")
    .option("--wallet <name>", cliOptions.walletPickList)
    .option("--password <password>", cliOptions.password)
    .addOption(passwordFileOption())
    .option("--dataDir <path>", cliOptions.dataDir)
    .option("--non-interactive", "Print activity as JSON")
    .action(async (opts) => {
      try {
        const dataDir = opts.dataDir ?? DEFAULT_DATA_DIR;
        const name = await resolveWalletNameOrPrompt({ dataDir, wallet: opts.wallet, nonInteractive: opts.nonInteractive });
        if (!name) return;
        const walletDir = resolveWalletDir(dataDir, name);
        const password = await resolveWalletPassword({
          flagPassword: opts.password, flagPasswordFile: opts.passwordFile,
          nonInteractive: opts.nonInteractive,
          validate: (candidate) => { readSeedKeystore(candidate, walletDir); },
        });
        if (!password) return;
        const entries = readActivity(walletDir, password);
        if (opts.nonInteractive) {
          console.log(JSON.stringify({ version: 1, wallet: name, activity: entries }));
          return;
        }
        if (entries.length === 0) console.log("No CLI activity recorded yet.");
        for (const entry of entries) {
          console.log(`${entry.timestamp}  ${entry.operation}${entry.protocol ? ` (${entry.protocol})` : ""}  chain ${entry.chainId}  ${entry.status}`);
          if (entry.txHash) console.log(`  tx: ${entry.txHash}`);
          if (entry.userOpHash) console.log(`  userOp: ${entry.userOpHash}`);
        }
      } catch (error) { cliErrorFromCaught(error); }
    });
}
