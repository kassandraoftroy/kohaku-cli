import "./bigint-json";
import "./reselect-init";

import { Command } from "commander";

import { registerBalancesCommand } from "./commands/balances";
import { registerCreateWalletCommand } from "./commands/createWallet";
import { registerExportPrivateKeyCommand } from "./commands/exportPrivateKey";
import { registerListWalletsCommand } from "./commands/listWallets";
import { registerNextFreshAddressCommand } from "./commands/nextFreshAddress";
import { registerRevealSeedPhraseCommand } from "./commands/revealSeedPhrase";
import { registerSeeDecryptedStorageCommand } from "./commands/seeDecryptedStorage";
import { registerShieldCommand } from "./commands/shield";
import { registerUnshieldCommand } from "./commands/unshield";
import { registerImportTornadoNoteCommand } from "./commands/import-tornado-note";
import { registerTransferCommand } from "./commands/transfer";
import { registerTransactRawCommand } from "./commands/transact-raw";
import { registerViewNetworkTrafficCommand } from "./commands/viewNetworkTraffic";
import { registerRegisterNameCommand } from "./commands/register-name";
import { registerRenewNameCommand } from "./commands/renew-name";
import { registerTransferNameCommand } from "./commands/transfer-name";
import { registerSetNameTextRecordCommand } from "./commands/set-name-text-record";
import { registerSetNameWebsiteCommand } from "./commands/set-name-website";
import { registerSetNameReverseRecordCommand } from "./commands/set-name-reverse-record";
import { registerInitWalletCommand } from "./commands/init-wallet";
import { cliErrorFromCaught } from "./utils/cli-errors";

async function main(): Promise<void> {
  const program = new Command();

  program
    .name("kohaku")
    .description("Kohaku CLI")
    .version("0.0.1");

  registerCreateWalletCommand(program);
  registerExportPrivateKeyCommand(program);
  registerRevealSeedPhraseCommand(program);
  registerListWalletsCommand(program);
  registerNextFreshAddressCommand(program);
  registerInitWalletCommand(program);
  registerShieldCommand(program);
  registerUnshieldCommand(program);
  registerImportTornadoNoteCommand(program);
  registerBalancesCommand(program);
  registerTransferCommand(program);
  registerTransactRawCommand(program);
  registerRegisterNameCommand(program);
  registerRenewNameCommand(program);
  registerTransferNameCommand(program);
  registerSetNameTextRecordCommand(program);
  registerSetNameWebsiteCommand(program);
  registerSetNameReverseRecordCommand(program);
  registerSeeDecryptedStorageCommand(program);
  registerViewNetworkTrafficCommand(program);

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
