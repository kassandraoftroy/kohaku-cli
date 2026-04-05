import chalk from "chalk";
import { Command } from "commander";

import { registerBalancesCommand } from "./commands/balances";
import { registerCreateWalletCommand } from "./commands/createWallet";
import { registerListWalletsCommand } from "./commands/listWallets";
import { registerNextFreshAddressCommand } from "./commands/nextFreshAddress";
import { registerSeeDecryptedStorageCommand } from "./commands/seeDecryptedStorage";
import { registerShieldCommand } from "./commands/shield";
import { registerUnshieldCommand } from "./commands/unshield";

async function main(): Promise<void> {
  const program = new Command();

  program
    .name("kohaku")
    .description("Kohaku CLI")
    .version("0.0.1");

  registerCreateWalletCommand(program);
  registerListWalletsCommand(program);
  registerNextFreshAddressCommand(program);
  registerShieldCommand(program);
  registerUnshieldCommand(program);
  registerBalancesCommand(program);
  registerSeeDecryptedStorageCommand(program);

  await program.parseAsync(process.argv);
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(chalk.red(msg));
  process.exitCode = 1;
});
