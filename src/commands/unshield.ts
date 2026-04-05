import { join } from "node:path";
import { confirm } from "@inquirer/prompts";
import { createPPv1Broadcaster } from "@kohaku-eth/privacy-pools";
import { log, spinner } from "@clack/prompts";
import chalk from "chalk";
import type { AssetAmount, Host } from "@kohaku-eth/plugins";
import type { Command } from "commander";
import { Contract, formatUnits, getAddress, isAddress, parseUnits } from "ethers";

import { makeHost } from "../host/makeHost";
import { readWalletType } from "../utils/wallet-type";
import { makeEthersProvider } from "../utils/eth-provider";
import {
  DEFAULT_DATA_DIR,
  resolveRpcUrl,
  walletNameToDirSegment,
} from "../utils/helpers";
import { resolveWalletNameOrPrompt } from "../utils/wallets";
import { readSeedKeystore } from "../utils/mnemonic";
import { makePublicAccountsStorage } from "../utils/public-accounts";
import {
  ETH_AS_ERC20,
  PRIVACY_POOLS_BROADCASTER_URL,
  PRIVACY_POOLS_TOKEN_WHITELIST,
  createProtocolPlugin,
  type SupportedProtocol,
} from "../utils/plugins";
import { resolveWalletPassword } from "../utils/wallet-password";

const ERC20_ABI = [
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];

type UnshieldOpts = {
  protocol?: SupportedProtocol;
  wallet?: string;
  password?: string;
  to?: string;
  next?: boolean;
  token?: string;
  amountWei?: string;
  amountFormatted?: string;
  rpcUrl?: string;
  nonInteractive?: boolean;
  dataDir?: string;
};

function resolveWalletDir(dataDir: string, walletName: string): string {
  return join(dataDir, walletNameToDirSegment(walletName));
}

async function resolveTokenMeta(
  tokenArg: string | undefined,
  rpcUrl: string
): Promise<{
  symbol: string;
  tokenAddress: string;
  decimals: number;
  isEth: boolean;
}> {
  if (!tokenArg || tokenArg.toLowerCase() === "eth") {
    return { symbol: "ETH", tokenAddress: ETH_AS_ERC20, decimals: 18, isEth: true };
  }
  if (!isAddress(tokenArg)) {
    throw new Error(`Invalid token address: ${tokenArg}`);
  }
  const tokenAddress = getAddress(tokenArg);
  const rpc = await makeEthersProvider(rpcUrl);
  try {
    const erc20 = new Contract(tokenAddress, ERC20_ABI, rpc);
    let decimals: number;
    try {
      decimals = Number(await erc20.decimals());
    } catch {
      throw new Error(`Failed to read decimals() from token ${tokenAddress}`);
    }
    const symbol = await erc20.symbol().catch(() => "UNKNOWN");
    return { symbol, tokenAddress, decimals, isEth: false };
  } finally {
    rpc.destroy();
  }
}

async function broadcastPreparedPrivateOp(
  protocol: SupportedProtocol,
  host: Host,
  plugin: unknown,
  operation: unknown
): Promise<void> {
  if (protocol === "railgun") {
    await (plugin as { broadcast: (op: unknown) => Promise<void> }).broadcast(
      operation
    );
    return;
  }
  const broadcaster = createPPv1Broadcaster(host, {
    broadcasterUrl: PRIVACY_POOLS_BROADCASTER_URL,
  });
  await broadcaster.broadcast(operation as never);
}

export function registerUnshieldCommand(program: Command): void {
  program
    .command("unshield")
    .description("Unshield private balance to a public address (via protocol relayer/broadcaster)")
    .requiredOption("--protocol <protocol>", "Protocol: railgun | privacy-pools")
    .option(
      "--wallet <name>",
      "Wallet name (omit to choose interactively from the list)"
    )
    .option("--password <password>", "Wallet password (required with --non-interactive; else prompted)")
    .option("--to <address>", "Public recipient address")
    .option("--next", "Unshield to the next fresh public account (addNextAccounts(1))")
    .option("--token <address|eth>", "Token address (default: eth)")
    .option("--amount-wei <amount>", "Raw token amount in wei/base units")
    .option("--amount-formatted <amount>", "Decimal amount (converted using token decimals)")
    .option("--rpc-url <url>", "RPC URL (or set RPC_URL)")
    .option(
      "--non-interactive",
      "Agent mode: no confirmation prompts; requires --password; --wallet required if omitted"
    )
    .option("--dataDir <path>", "Kohaku data directory (default: ~/.kohaku-cli)")
    .action(async (opts: UnshieldOpts) => {
      const protocol = opts.protocol;
      if (protocol !== "railgun" && protocol !== "privacy-pools") {
        log.error(chalk.red('✖ --protocol must be "railgun" or "privacy-pools".'));
        process.exitCode = 1;
        return;
      }

      const hasTo = !!opts.to?.trim();
      const hasNext = !!opts.next;
      if (hasTo === hasNext) {
        log.error(
          chalk.red("✖ Provide exactly one of --to <address> or --next.")
        );
        process.exitCode = 1;
        return;
      }

      if (!!opts.amountWei === !!opts.amountFormatted) {
        log.error(chalk.red("✖ Provide exactly one of --amount-wei or --amount-formatted."));
        process.exitCode = 1;
        return;
      }

      const rpcUrl = resolveRpcUrl(opts.rpcUrl);
      if (!rpcUrl) {
        log.error(chalk.red("✖ Missing --rpc-url (or environment variable RPC_URL)."));
        process.exitCode = 1;
        return;
      }

      const dataDir = opts.dataDir ?? DEFAULT_DATA_DIR;
      const walletName = await resolveWalletNameOrPrompt({
        dataDir,
        wallet: opts.wallet,
        nonInteractive: opts.nonInteractive,
      });
      if (!walletName) {
        process.exitCode = 1;
        return;
      }

      let walletDir: string;
      try {
        walletDir = resolveWalletDir(dataDir, walletName);
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

      const walletChainId = readWalletType(walletDir) === "testnet" ? "11155111" : "1";
      const rpc = await makeEthersProvider(rpcUrl);
      let chainId: bigint;
      try {
        chainId = (await rpc.getNetwork()).chainId;
      } finally {
        rpc.destroy();
      }
      if (chainId.toString() !== walletChainId) {
        log.error(
          chalk.red(
            `✖ RPC chainId ${chainId.toString()} does not match wallet chainId ${walletChainId}.`
          )
        );
        process.exitCode = 1;
        return;
      }

      let recipient: `0x${string}`;
      if (hasNext) {
        const storage = makePublicAccountsStorage(walletDir, mnemonic, password);
        const added = storage.addNextAccounts(1);
        recipient = getAddress(added[0]!.address) as `0x${string}`;
      } else {
        const raw = opts.to!.trim();
        if (!isAddress(raw)) {
          log.error(chalk.red(`✖ Invalid --to address: ${raw}`));
          process.exitCode = 1;
          return;
        }
        recipient = getAddress(raw) as `0x${string}`;
      }

      let tokenMeta: Awaited<ReturnType<typeof resolveTokenMeta>>;
      try {
        tokenMeta = await resolveTokenMeta(opts.token, rpcUrl);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        log.error(chalk.red(`✖ ${msg}`));
        process.exitCode = 1;
        return;
      }

      if (protocol === "privacy-pools" && !tokenMeta.isEth) {
        const wl =
          PRIVACY_POOLS_TOKEN_WHITELIST[chainId.toString()] ?? new Set<string>();
        if (!wl.has(tokenMeta.tokenAddress.toLowerCase())) {
          log.error(
            chalk.red(
              `✖ Token ${tokenMeta.tokenAddress} is not whitelisted for privacy-pools on chain ${chainId.toString()}.`
            )
          );
          process.exitCode = 1;
          return;
        }
      }

      const amount = opts.amountWei
        ? BigInt(opts.amountWei)
        : parseUnits(opts.amountFormatted ?? "0", tokenMeta.decimals);
      if (amount <= 0n) {
        log.error(chalk.red("✖ Amount must be greater than zero."));
        process.exitCode = 1;
        return;
      }

      const asset: AssetAmount = {
        asset: {
          __type: "erc20",
          contract: tokenMeta.tokenAddress as `0x${string}`,
        },
        amount,
      };

      const rpcForHost = await makeEthersProvider(rpcUrl);
      const spin = spinner();
      try {
        const host = await makeHost({
          rpc: rpcForHost,
          walletDir,
          password,
          mnemonic,
          pluginId: protocol === "railgun" ? "rg" : "ppv1",
        });
        const plugin = await createProtocolPlugin(protocol, host, chainId);

        if (!opts.nonInteractive) {
          console.log(
            chalk.yellow(
              "Unshielding sends a private withdrawal through the protocol relayer/broadcaster. Review the amount and recipient carefully."
            )
          );
        }

        if (protocol === "privacy-pools" && "sync" in plugin && typeof plugin.sync === "function") {
          spin.start("Syncing private state…");
          try {
            await plugin.sync();
            spin.stop("Private state synced.");
          } catch (syncErr) {
            spin.stop("Sync failed.");
            throw syncErr;
          }
        }

        const prepareLabel =
          protocol === "railgun"
            ? "Building Railgun unshield (proof + broadcaster selection)…"
            : "Building Privacy Pools unshield (proof + relayer quote)…";
        spin.start(prepareLabel);
        let privateOp: unknown;
        try {
          const prepareUnshield = (
            plugin as unknown as {
              prepareUnshield: (
                a: AssetAmount,
                t: `0x${string}`
              ) => Promise<unknown>;
            }
          ).prepareUnshield.bind(plugin);
          privateOp = await prepareUnshield(asset, recipient);
          spin.stop("Unshield operation prepared.");
        } catch (prepErr) {
          spin.stop("Prepare failed.");
          throw prepErr;
        }

        const amountLabel = `${formatUnits(amount, tokenMeta.decimals)} ${tokenMeta.symbol}`;
        const via =
          protocol === "railgun"
            ? "Railgun (Waku broadcaster)"
            : "Privacy Pools relayer";
        if (!opts.nonInteractive) {
          const ok = await confirm({
            message:
              `Broadcast this unshield via ${via}?\n` +
              `  Amount: ${amountLabel}\n` +
              `  To: ${recipient}\n` +
              `This submits the operation to the network and may be irreversible.`,
            default: false,
          });
          if (!ok) {
            log.warn("Cancelled.");
            process.exitCode = 1;
            return;
          }
        }

        spin.start("Broadcasting unshield…");
        try {
          await broadcastPreparedPrivateOp(
            protocol,
            host,
            plugin,
            privateOp
          );
          spin.stop("Unshield broadcast complete.");
        } catch (bcErr) {
          spin.stop("Broadcast failed.");
          throw bcErr;
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        log.error(chalk.red(`✖ ${msg}`));
        process.exitCode = 1;
        return;
      } finally {
        rpcForHost.destroy();
      }

      console.log(chalk.green("✔ Unshield flow completed."));
    });
}
