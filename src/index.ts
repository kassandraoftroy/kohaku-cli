import "./bigint-json";
import "./reselect-init";

import { Command } from "commander";

import { registerBalancesCommand } from "./commands/balances";
import { registerCreateWalletCommand } from "./commands/createWallet";
import { registerExportPrivateKeyCommand } from "./commands/exportPrivateKey";
import { registerListWalletsCommand } from "./commands/listWallets";
import { registerNextFreshAddressCommand } from "./commands/nextFreshAddress";
import { registerSeeDecryptedStorageCommand } from "./commands/seeDecryptedStorage";
import { registerShieldCommand } from "./commands/shield";
import { registerUnshieldCommand } from "./commands/unshield";
import { registerTransferCommand } from "./commands/transfer";
import { registerTransactRawCommand } from "./commands/transact-raw";
import { registerTuiCommand } from "./commands/tui";
import { cliErrorFromCaught } from "./utils/cli-errors";

async function main(): Promise<void> {
  const program = new Command();

  program
    .name("kohaku")
    .description("Kohaku CLI")
    .version("0.0.1");

  registerCreateWalletCommand(program);
  registerExportPrivateKeyCommand(program);
  registerListWalletsCommand(program);
  registerNextFreshAddressCommand(program);
  registerShieldCommand(program);
  registerUnshieldCommand(program);
  registerBalancesCommand(program);
  registerTransferCommand(program);
  registerTransactRawCommand(program);
  registerSeeDecryptedStorageCommand(program);
  registerTuiCommand(program);

  await program.parseAsync(process.argv);
}

function exitCli(forceCode?: number): never {
  const code = forceCode ?? process.exitCode ?? 0;
  process.exit(code);
}

main()
  .then(() => exitCli())
  .catch((err: unknown) => {
    cliErrorFromCaught(err);
    exitCli(1);
  });
