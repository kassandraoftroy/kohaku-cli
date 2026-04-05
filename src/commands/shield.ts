import { join } from "node:path";
import { confirm } from "@inquirer/prompts";
import { log, spinner } from "@clack/prompts";
import chalk from "chalk";
import type { AssetAmount } from "@kohaku-eth/plugins";
import type { Command } from "commander";
import { Contract, Wallet, formatUnits, getAddress, isAddress, parseUnits } from "ethers";
import { Mnemonic } from "derive-railgun-keys";

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
  PRIVACY_POOLS_TOKEN_WHITELIST,
  createProtocolPlugin,
  type SupportedProtocol,
} from "../utils/plugins";
import { resolveWalletPassword } from "../utils/wallet-password";

const ERC20_ABI = [
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
];

type ShieldOpts = {
  protocol?: SupportedProtocol;
  wallet?: string;
  password?: string;
  from?: string;
  fromPriv?: boolean;
  token?: string;
  amountWei?: string;
  amountFormatted?: string;
  rpcUrl?: string;
  baseFeeGwei?: string;
  priorityFeeGwei?: string;
  nonInteractive?: boolean;
  dataDir?: string;
};

type FeeOverrides = {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
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

function parseFromIndex(fromValue: string): number | null {
  if (!/^\d+$/.test(fromValue)) return null;
  const parsed = Number(fromValue);
  if (!Number.isInteger(parsed) || parsed < 0) return null;
  return parsed;
}

async function maybeConfirm(nonInteractive: boolean, message: string): Promise<void> {
  if (nonInteractive) return;
  const ok = await confirm({ message, default: false });
  if (!ok) {
    throw new Error("Cancelled by user.");
  }
}

async function computeFees(rpcUrl: string, opts: ShieldOpts): Promise<FeeOverrides> {
  if (opts.baseFeeGwei || opts.priorityFeeGwei) {
    const base = opts.baseFeeGwei ? parseUnits(opts.baseFeeGwei, 9) : 0n;
    const priority = opts.priorityFeeGwei ? parseUnits(opts.priorityFeeGwei, 9) : 0n;
    return { maxFeePerGas: base + priority, maxPriorityFeePerGas: priority };
  }

  const rpc = await makeEthersProvider(rpcUrl);
  try {
    const latest = await rpc.getBlock("latest");
    const base = latest?.baseFeePerGas ?? 0n;
    const priority = 0n;
    const maxFee = (base * 110n) / 100n + priority;
    return { maxFeePerGas: maxFee, maxPriorityFeePerGas: priority };
  } finally {
    rpc.destroy();
  }
}

function toShieldTxs(op: unknown): Array<{ to: string; data: string; value: bigint }> {
  if (
    typeof op === "object" &&
    op !== null &&
    "txns" in op &&
    Array.isArray((op as { txns?: unknown[] }).txns)
  ) {
    return (op as { txns: Array<{ to: string; data: string; value: bigint }> }).txns;
  }
  if (
    typeof op === "object" &&
    op !== null &&
    "to" in op &&
    "data" in op &&
    "value" in op
  ) {
    return [op as { to: string; data: string; value: bigint }];
  }
  throw new Error("Unsupported shield operation shape returned by plugin.");
}

export function registerShieldCommand(program: Command): void {
  program
    .command("shield")
    .description("Shield public funds into a privacy protocol")
    .requiredOption("--protocol <protocol>", "Protocol: railgun | privacy-pools")
    .option(
      "--wallet <name>",
      "Wallet name (omit to choose interactively from the list)"
    )
    .option("--password <password>", "Wallet password (required with --non-interactive; else prompted)")
    .requiredOption("--from <address-or-index>", "Public sender address or public-account index")
    .option("--from-priv", "Allow deriving the --from index directly from mnemonic if not in public accounts")
    .option("--token <address|eth>", "Token address (default: eth)")
    .option("--amount-wei <amount>", "Raw token amount in wei/base units")
    .option("--amount-formatted <amount>", "Decimal amount (converted using token decimals)")
    .option("--rpc-url <url>", "RPC URL (or set RPC_URL)")
    .option("--base-fee-gwei <gwei>", "Base fee (gwei)")
    .option("--priority-fee-gwei <gwei>", "Priority fee (gwei)")
    .option(
      "--non-interactive",
      "Agent mode: no confirmation prompts; requires --password; --wallet required if omitted"
    )
    .option("--dataDir <path>", "Kohaku data directory (default: ~/.kohaku-cli)")
    .action(async (opts: ShieldOpts) => {
      const protocol = opts.protocol;
      if (protocol !== "railgun" && protocol !== "privacy-pools") {
        log.error(chalk.red('✖ --protocol must be "railgun" or "privacy-pools".'));
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
      const fromValue = opts.from ?? "";

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

      const tokenMeta = await resolveTokenMeta(opts.token, rpcUrl);
      if (protocol === "privacy-pools" && !tokenMeta.isEth) {
        const wl = PRIVACY_POOLS_TOKEN_WHITELIST[chainId.toString()] ?? new Set<string>();
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

      const fromIndex = parseFromIndex(fromValue);
      let senderPrivateKey: string;
      let senderAddress: string;
      if (fromIndex !== null) {
        const publicStorage = makePublicAccountsStorage(walletDir, mnemonic, password);
        const account = publicStorage.getAccount(fromIndex);
        if (account) {
          senderPrivateKey = account.priv;
          senderAddress = account.address;
        } else if (opts.fromPriv) {
          senderPrivateKey = Mnemonic.to0xPrivateKeyByIndex(mnemonic, fromIndex);
          senderAddress = new Wallet(senderPrivateKey).address;
        } else {
          log.error(
            chalk.red(
              `✖ Public account index ${fromIndex} not found. Use --from-priv to derive directly from mnemonic.`
            )
          );
          process.exitCode = 1;
          return;
        }
      } else if (isAddress(fromValue)) {
        senderAddress = getAddress(fromValue);
        const publicStorage = makePublicAccountsStorage(walletDir, mnemonic, password);
        const match = publicStorage.getAccounts().find((x) => x.address.toLowerCase() === senderAddress.toLowerCase());
        if (!match) {
          log.error(
            chalk.red(
              `✖ Address ${senderAddress} is not in this wallet's public accounts. Use an index with --from-priv for direct derivation.`
            )
          );
          process.exitCode = 1;
          return;
        }
        senderPrivateKey = match.priv;
      } else {
        log.error(chalk.red("✖ --from must be either a valid address or a non-negative index."));
        process.exitCode = 1;
        return;
      }

      const rpcForHost = await makeEthersProvider(rpcUrl);
      const txSpinner = spinner();
      try {
        const host = await makeHost({
          rpc: rpcForHost,
          walletDir,
          password,
          mnemonic,
          pluginId: protocol === "railgun" ? "rg" : "ppv1",
        });
        const plugin = await createProtocolPlugin(protocol, host, chainId);

        const asset: AssetAmount = {
          asset: { __type: "erc20", contract: tokenMeta.tokenAddress as `0x${string}` },
          amount,
        };
        const op = await plugin.prepareShield(asset as AssetAmount);
        const txs = toShieldTxs(op);

        const signer = new Wallet(senderPrivateKey, rpcForHost);
        // const feeOverrides = await computeFees(rpcUrl, opts);
        const amountPreview = `${formatUnits(amount, tokenMeta.decimals)} ${tokenMeta.symbol}`;

        for (const [i, tx] of txs.entries()) {
          if (!tokenMeta.isEth) {
            const erc20 = new Contract(tokenMeta.tokenAddress, ERC20_ABI, signer);
            const allowance: bigint = await erc20.allowance(senderAddress, tx.to);
            if (allowance < amount) {
              await maybeConfirm(
                !!opts.nonInteractive,
                `Send approval transaction (${tokenMeta.symbol}) to ${tx.to}?`
              );
              txSpinner.start(`Sending approval ${i + 1}/${txs.length}...`);
              const approveTx = await erc20.approve(tx.to, amount/*, feeOverrides*/);
              await approveTx.wait();
              txSpinner.stop(`Approval mined: ${approveTx.hash}`);
            }
          }

          await maybeConfirm(
            !!opts.nonInteractive,
            `Send shield transaction ${i + 1}/${txs.length} for ${amountPreview} from ${senderAddress}?`
          );
          txSpinner.start(`Sending shield tx ${i + 1}/${txs.length}...`);

          const sent = await signer.sendTransaction({
            to: tx.to,
            data: tx.data,
            value: tx.value,
            gasLimit: 2000000,
            // ...feeOverrides,
          });
          await sent.wait();
          txSpinner.stop(`Shield tx mined: ${sent.hash}`);
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        log.error(chalk.red(`✖ ${msg}`));
        process.exitCode = 1;
        return;
      } finally {
        rpcForHost.destroy();
      }

      console.log(chalk.green("✔ Shield flow completed."));
    });
}
