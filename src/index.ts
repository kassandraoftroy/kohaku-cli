import chalk from "chalk";
import { Command } from "commander";

import { registerCreateWalletCommand } from "./commands/createWallet";

async function main(): Promise<void> {
  const program = new Command();
  program
    .name("kohaku")
    .description("Kohaku CLI")
    .version("0.0.1");

  registerCreateWalletCommand(program);

  await program.parseAsync(process.argv);
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(chalk.red(msg));
  process.exitCode = 1;
});
