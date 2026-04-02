import { join } from "node:path";
import { log, spinner } from "@clack/prompts";
import chalk from "chalk";
import type { AssetAmount } from "@kohaku-eth/plugins";
import type { Command } from "commander";
import { formatUnits } from "ethers";

import { makeHost } from "../host/makeHost";
import { readWalletChainId } from "../utils/chain-id";
import { makeEthersProvider } from "../utils/eth-provider";
import { DEFAULT_DATA_DIR, walletNameToDirSegment } from "../utils/helpers";
import { readSeedKeystore } from "../utils/mnemonic";
import { makePublicAccountsStorage } from "../utils/public-accounts";
import { createProtocolPlugin, type SupportedProtocol } from "../utils/plugins";

type BalancesOpts = {
  wallet?: string;
  password?: string;
  rpcUrl?: string;
  dataDir?: string;
};

type BalanceItem = {
  symbol: string;
  token_address: string;
  decimals: number;
  raw_token_holdings: string;
  formatted_token_holdings: string;
};

function mapPrivateBalanceRow(row: AssetAmount): BalanceItem {
  const addr = (row.asset as { contract?: string } | undefined)?.contract ?? "---";
  const decimals = 18;
  return {
    symbol: addr.toLowerCase() === "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" ? "ETH" : "UNKNOWN",
    token_address: addr,
    decimals,
    raw_token_holdings: row.amount.toString(),
    formatted_token_holdings: formatUnits(row.amount, decimals),
  };
}

async function getPrivateBalances(
  protocol: SupportedProtocol,
  chainId: bigint,
  rpcUrl: string,
  walletDir: string,
  password: string,
  mnemonic: string
): Promise<BalanceItem[]> {
  const rpc = await makeEthersProvider(rpcUrl);
  try {
    const host = await makeHost({
      rpc,
      walletDir,
      password,
      mnemonic,
      pluginId: protocol === "railgun" ? "rg" : "ppv1",
    });
    const plugin = await createProtocolPlugin(protocol, host, chainId);
    if ("sync" in plugin && typeof plugin.sync === "function") {
      await plugin.sync();
    }
    const rows = await plugin.balance(undefined);
    return rows.map(mapPrivateBalanceRow);
  } finally {
    rpc.destroy();
  }
}

export function registerBalancesCommand(program: Command): void {
  program
    .command("balances")
    .description("Print wallet balances (public + private) as JSON")
    .option("--wallet <name>", "Wallet name", "default")
    .requiredOption("--password <password>", "Wallet password")
    .option("--rpc-url <url>", "RPC URL (or set RPC_URL)")
    .option("--dataDir <path>", "Kohaku data directory (default: ~/.kohaku-cli)")
    .action(async (opts: BalancesOpts) => {
      const walletName = opts.wallet ?? "default";
      const password = opts.password ?? "";
      const rpcUrl = opts.rpcUrl?.trim() || process.env.RPC_URL?.trim() || "";
      if (!rpcUrl) {
        log.error(chalk.red("✖ Missing --rpc-url (or environment variable RPC_URL)."));
        process.exitCode = 1;
        return;
      }

      const dataDir = opts.dataDir ?? DEFAULT_DATA_DIR;
      let walletDir: string;
      try {
        walletDir = join(dataDir, walletNameToDirSegment(walletName));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        log.error(chalk.red(`✖ ${msg}`));
        process.exitCode = 1;
        return;
      }

      let mnemonic: string;
      try {
        mnemonic = readSeedKeystore(password, walletDir);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        log.error(chalk.red(`✖ ${msg}`));
        process.exitCode = 1;
        return;
      }

      const chainIdFile = readWalletChainId(walletDir);
      const rpc = await makeEthersProvider(rpcUrl);
      let rpcChainId: bigint;
      try {
        const network = await rpc.getNetwork();
        rpcChainId = network.chainId;
      } finally {
        rpc.destroy();
      }
      if (rpcChainId.toString() !== chainIdFile) {
        log.error(
          chalk.red(
            `✖ RPC chainId ${rpcChainId.toString()} does not match wallet chainId ${chainIdFile}.`
          )
        );
        process.exitCode = 1;
        return;
      }

      const loading = spinner();
      loading.start("Loading public and private balances...");

      const publicStorage = makePublicAccountsStorage(walletDir, mnemonic, password);
      const publicAccounts = publicStorage.getAccounts();

      const publicByAddress: Record<string, BalanceItem[]> = {};
      const aggregatedEth: bigint[] = [];
      const rpcForPublic = await makeEthersProvider(rpcUrl);
      try {
        for (const acct of publicAccounts) {
          const ethBalance = await rpcForPublic.getBalance(acct.address);
          aggregatedEth.push(ethBalance);
          publicByAddress[acct.address] = [
            {
              symbol: "ETH",
              token_address: "---",
              decimals: 18,
              raw_token_holdings: ethBalance.toString(),
              formatted_token_holdings: formatUnits(ethBalance, 18),
            },
          ];
        }
      } finally {
        rpcForPublic.destroy();
      }

      const totalPublicEth = aggregatedEth.reduce((a, b) => a + b, 0n);

      const [railgunBalances, ppBalances] = await Promise.all([
        getPrivateBalances("railgun", rpcChainId, rpcUrl, walletDir, password, mnemonic),
        getPrivateBalances("privacy-pools", rpcChainId, rpcUrl, walletDir, password, mnemonic),
      ]);

      loading.stop("Balances loaded.");

      const payload = {
        public_balances_aggregated: [
          {
            symbol: "ETH",
            token_address: "---",
            decimals: 18,
            raw_token_holdings: totalPublicEth.toString(),
            formatted_token_holdings: formatUnits(totalPublicEth, 18),
          },
        ],
        private_balances: {
          "privacy-pools": ppBalances,
          railgun: railgunBalances,
        },
        public_balances_by_address: publicByAddress,
      };
      console.log(JSON.stringify(payload, null, 2));
    });
}
