import { join } from "node:path";
import chalk from "chalk";
import type { Command } from "commander";

import { cliOptions } from "../utils/cli-command-options";
import { DEFAULT_DATA_DIR } from "../utils/rpc";
import {
  listWalletDirNames,
  walletNetworkKind,
  type WalletNetworkKind,
} from "../utils/wallets-util";

type ListWalletsOpts = {
  dataDir?: string;
  nonInteractive?: boolean;
};

function mainnetFieldForJson(kind: WalletNetworkKind): boolean | null {
  if (kind === "mainnet") {
    return true;
  }
  if (kind === "testnet") {
    return false;
  }
  return null;
}

export function registerListWalletsCommand(program: Command): void {
  program
    .command("list-wallets")
    .description("List existing wallets by name with mainnet or testnet")
    .option("--dataDir <path>", cliOptions.dataDir)
    .option("--non-interactive", cliOptions.nonInteractiveListWallets)
    .action((opts: ListWalletsOpts) => {
      const dataDir = opts.dataDir ?? DEFAULT_DATA_DIR;
      const names = listWalletDirNames(dataDir);

      if (opts.nonInteractive) {
        const wallets: Record<string, { mainnet: boolean | null }> = {};
        for (const name of names) {
          const kind = walletNetworkKind(join(dataDir, name));
          wallets[name] = { mainnet: mainnetFieldForJson(kind) };
        }
        console.log(JSON.stringify({ wallets }));
        return;
      }

      if (names.length === 0) {
        console.log(chalk.dim("No wallets found."));
        return;
      }

      console.log("Wallets:");
      console.log();
      for (const name of names) {
        const kind = walletNetworkKind(join(dataDir, name));
        const typeLabel =
          kind === "unknown" ? "unknown" : kind === "mainnet" ? "mainnet" : "testnet";
        console.log(` - ${name} (${typeLabel})`);
      }
    });
}
