import { join } from "node:path";
import chalk from "chalk";
import { Option, type Command } from "commander";

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
  format?: "json-v1";
};

export const WALLET_LIST_KIND = "kohaku-cli/wallet-list" as const;

export type WalletListV1 = {
  kind: typeof WALLET_LIST_KIND;
  version: 1;
  wallets: Array<{
    name: string;
    network: WalletNetworkKind;
    chainId: number | null;
    caip2: string | null;
  }>;
};

/** Locale-independent UTF-16 ordering for a reproducible machine contract. */
export function compareWalletNamesV1(a: string, b: string): number {
  return a === b ? 0 : a < b ? -1 : 1;
}

function mainnetFieldForJson(kind: WalletNetworkKind): boolean | null {
  if (kind === "mainnet") {
    return true;
  }
  if (kind === "testnet") {
    return false;
  }
  return null;
}

export function listWalletsV1(dataDir: string): WalletListV1 {
  return {
    kind: WALLET_LIST_KIND,
    version: 1,
    wallets: [...listWalletDirNames(dataDir)]
      .sort(compareWalletNamesV1)
      .map((name) => {
        const network = walletNetworkKind(join(dataDir, name));
        const chainId =
          network === "mainnet" ? 1 : network === "testnet" ? 11155111 : null;
        return {
          name,
          network,
          chainId,
          caip2: chainId === null ? null : `eip155:${chainId}`,
        };
      }),
  };
}

export function registerListWalletsCommand(program: Command): void {
  program
    .command("list-wallets")
    .description("List existing wallets by name with mainnet or testnet")
    .option("--dataDir <path>", cliOptions.dataDir)
    .option("--non-interactive", cliOptions.nonInteractiveListWallets)
    .addOption(
      new Option(
        "--format <format>",
        "Output format; json-v1 is a versioned schema for machine consumers"
      ).choices(["json-v1"])
    )
    .action((opts: ListWalletsOpts) => {
      const dataDir = opts.dataDir ?? DEFAULT_DATA_DIR;
      const names = listWalletDirNames(dataDir);

      if (opts.format === "json-v1") {
        console.log(JSON.stringify(listWalletsV1(dataDir)));
        return;
      }

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
