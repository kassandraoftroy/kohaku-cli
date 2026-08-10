import "./bigint-json";
import "./reselect-init";

import { createRequire } from "node:module";
import { Command } from "commander";

import { registerBalancesCommand } from "./commands/balances";
import { registerCreateWalletCommand } from "./commands/createWallet";
import { registerExportPrivateKeyCommand } from "./commands/exportPrivateKey";
import { registerListWalletsCommand } from "./commands/listWallets";
import { registerNextFreshAddressCommand } from "./commands/nextFreshAddress";
import { registerRevealSeedPhraseCommand } from "./commands/revealSeedPhrase";
import { registerSeeDecryptedStorageCommand } from "./commands/seeDecryptedStorage";
import { registerSeeStealthMetaAddressCommand } from "./commands/see-stealth-meta-address";
import { registerShieldCommand } from "./commands/shield";
import { registerUnshieldCommand } from "./commands/unshield";
import { registerImportTornadoNoteCommand } from "./commands/import-tornado-note";
import { registerExportTornadoNoteCommand } from "./commands/export-tornado-note";
import { registerTransferCommand } from "./commands/transfer";
import { registerTransactRawCommand } from "./commands/transact-raw";
import { registerViewNetworkTrafficCommand } from "./commands/viewNetworkTraffic";
import { registerClearTorCacheCommand } from "./commands/clear-tor-cache";
import { registerRegisterNameCommand } from "./commands/register-name";
import { registerRenewNameCommand } from "./commands/renew-name";
import { registerTransferNameCommand } from "./commands/transfer-name";
import { registerSetNameTextRecordCommand } from "./commands/set-name-text-record";
import { registerSetNameWebsiteCommand } from "./commands/set-name-website";
import { registerSetNameReverseRecordCommand } from "./commands/set-name-reverse-record";
import { registerInitProfileCommand } from "./commands/init-profile";
import { cliErrorFromCaught } from "./utils/cli-errors";

const require = createRequire(import.meta.url);
const { version: cliVersion } = require("../package.json") as {
  version: string;
};

async function main(): Promise<void> {
  const program = new Command();

  program
    .name("kohaku")
    .description("Kohaku CLI")
    .version(cliVersion);

  registerCreateWalletCommand(program);
  registerExportPrivateKeyCommand(program);
  registerRevealSeedPhraseCommand(program);
  registerListWalletsCommand(program);
  registerNextFreshAddressCommand(program);
  registerInitProfileCommand(program);
  registerShieldCommand(program);
  registerUnshieldCommand(program);
  registerImportTornadoNoteCommand(program);
  registerExportTornadoNoteCommand(program);
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
  registerSeeStealthMetaAddressCommand(program);
  registerViewNetworkTrafficCommand(program);
  registerClearTorCacheCommand(program);

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
