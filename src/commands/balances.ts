import { join } from "node:path";
import { log, spinner } from "@clack/prompts";
import chalk from "chalk";
import type { AssetAmount } from "@kohaku-eth/plugins";
import type { Command } from "commander";
import { Contract, formatUnits, getAddress, isAddress } from "ethers";

import { makeHost } from "../host/makeHost";
import { readWalletType } from "../utils/wallet-type";
import { makeEthersProvider } from "../utils/eth-provider";
import { DEFAULT_DATA_DIR, walletNameToDirSegment } from "../utils/helpers";
import { readSeedKeystore } from "../utils/mnemonic";
import { makePublicAccountsStorage } from "../utils/public-accounts";
import { createProtocolPlugin, type SupportedProtocol } from "../utils/plugins";
import { resolveWalletPassword } from "../utils/wallet-password";

const ERC20_ABI = [
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];

type BalancesOpts = {
  wallet?: string;
  password?: string;
  nonInteractive?: boolean;
  rpcUrl?: string;
  tokensList?: string;
  dataDir?: string;
};

type BalanceItem = {
  symbol: string;
  token_address: string;
  decimals: number;
  raw_token_holdings: string;
  formatted_token_holdings: string;
};

function parseTokensList(raw: string | undefined): `0x${string}`[] {
  if (!raw?.trim()) return [];
  const parts = raw.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
  const seen = new Set<string>();
  const out: `0x${string}`[] = [];
  for (const p of parts) {
    if (!isAddress(p)) {
      throw new Error(`Invalid ERC20 address in --tokensList: ${p}`);
    }
    const addr = getAddress(p) as `0x${string}`;
    const key = addr.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(addr);
  }
  return out;
}

async function loadErc20Meta(
  provider: Awaited<ReturnType<typeof makeEthersProvider>>,
  token: `0x${string}`
): Promise<{ symbol: string; decimals: number }> {
  const c = new Contract(token, ERC20_ABI, provider);
  let decimals: number;
  try {
    decimals = Number(await c.decimals());
  } catch {
    throw new Error(`Failed to read decimals() for token ${token}`);
  }
  const symbol = await c.symbol().catch(() => "UNKNOWN");
  return { symbol, decimals };
}

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
    .option("--password <password>", "Wallet password (required with --non-interactive; else prompted)")
    .option("--non-interactive", "No prompts (requires --password)")
    .option("--rpc-url <url>", "RPC URL (or set RPC_URL)")
    .option(
      "--tokensList <addrs>",
      "Comma- or space-separated ERC20 addresses to fetch for every public account"
    )
    .option("--dataDir <path>", "Kohaku data directory (default: ~/.kohaku-cli)")
    .action(async (opts: BalancesOpts) => {
      const walletName = opts.wallet ?? "default";
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

      const password = await resolveWalletPassword({
        flagPassword: opts.password,
        nonInteractive: opts.nonInteractive,
      });
      if (!password) {
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

      const chainIdString = readWalletType(walletDir) === "testnet" ? "11155111" : "1";
      const rpc = await makeEthersProvider(rpcUrl);
      let rpcChainId: bigint;
      try {
        const network = await rpc.getNetwork();
        rpcChainId = network.chainId;
      } finally {
        rpc.destroy();
      }
      if (rpcChainId.toString() !== chainIdString) {
        log.error(
          chalk.red(
            `✖ RPC chainId ${rpcChainId.toString()} does not match wallet chainId ${chainIdString}.`
          )
        );
        process.exitCode = 1;
        return;
      }

      let tokenAddresses: `0x${string}`[];
      try {
        tokenAddresses = parseTokensList(opts.tokensList);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        log.error(chalk.red(`✖ ${msg}`));
        process.exitCode = 1;
        return;
      }

      const loading = spinner();
      loading.start("Loading public and private balances...");

      const publicStorage = makePublicAccountsStorage(walletDir, mnemonic, password);
      const publicAccounts = publicStorage.getAccounts();

      const publicByAddress: Record<string, BalanceItem[]> = {};
      const aggregatedEth: bigint[] = [];
      const aggregatedByToken = new Map<string, bigint>();
      for (const t of tokenAddresses) {
        aggregatedByToken.set(t.toLowerCase(), 0n);
      }

      const rpcForPublic = await makeEthersProvider(rpcUrl);
      const tokenMeta = new Map<string, { symbol: string; decimals: number }>();
      try {
        for (const token of tokenAddresses) {
          tokenMeta.set(token.toLowerCase(), await loadErc20Meta(rpcForPublic, token));
        }

        const now = Date.now();
        const updatedAccounts: typeof publicAccounts = [];

        for (const acct of publicAccounts) {
          const ethBalance = await rpcForPublic.getBalance(acct.address);
          aggregatedEth.push(ethBalance);

          const erc20Balances = { ...acct.erc20Balances };
          const rows: BalanceItem[] = [
            {
              symbol: "ETH",
              token_address: "---",
              decimals: 18,
              raw_token_holdings: ethBalance.toString(),
              formatted_token_holdings: formatUnits(ethBalance, 18),
            },
          ];

          for (const token of tokenAddresses) {
            const key = token.toLowerCase();
            const c = new Contract(token, ERC20_ABI, rpcForPublic);
            const bal: bigint = await c.balanceOf(acct.address);
            erc20Balances[key] = bal.toString();
            aggregatedByToken.set(key, (aggregatedByToken.get(key) ?? 0n) + bal);
            const meta = tokenMeta.get(key)!;
            rows.push({
              symbol: meta.symbol,
              token_address: token,
              decimals: meta.decimals,
              raw_token_holdings: bal.toString(),
              formatted_token_holdings: formatUnits(bal, meta.decimals),
            });
          }

          updatedAccounts.push({
            ...acct,
            ethBalance: ethBalance.toString(),
            erc20Balances,
            lastUpdated: now,
          });

          publicByAddress[acct.address] = rows;
        }

        if (updatedAccounts.length > 0) {
          publicStorage.setAccounts(updatedAccounts);
        }
      } finally {
        rpcForPublic.destroy();
      }

      const totalPublicEth = aggregatedEth.reduce((a, b) => a + b, 0n);

      const publicBalancesAggregated: BalanceItem[] = [
        {
          symbol: "ETH",
          token_address: "---",
          decimals: 18,
          raw_token_holdings: totalPublicEth.toString(),
          formatted_token_holdings: formatUnits(totalPublicEth, 18),
        },
      ];
      for (const token of tokenAddresses) {
        const key = token.toLowerCase();
        const meta = tokenMeta.get(key)!;
        const total = aggregatedByToken.get(key) ?? 0n;
        publicBalancesAggregated.push({
          symbol: meta.symbol,
          token_address: token,
          decimals: meta.decimals,
          raw_token_holdings: total.toString(),
          formatted_token_holdings: formatUnits(total, meta.decimals),
        });
      }

      const [railgunBalances, ppBalances] = await Promise.all([
        getPrivateBalances("railgun", rpcChainId, rpcUrl, walletDir, password, mnemonic),
        getPrivateBalances("privacy-pools", rpcChainId, rpcUrl, walletDir, password, mnemonic),
      ]);

      loading.stop("Balances loaded.");

      const payload = {
        public_balances_aggregated: publicBalancesAggregated,
        private_balances: {
          "privacy-pools": ppBalances,
          railgun: railgunBalances,
        },
        public_balances_by_address: publicByAddress,
      };
      console.log(JSON.stringify(payload, null, 2));
    });
}
