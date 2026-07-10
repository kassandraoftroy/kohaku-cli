import { confirm, input, select } from "@inquirer/prompts";
import { spinner } from "@clack/prompts";
import chalk from "chalk";
import type { Command } from "commander";
import {
  Contract,
  Interface,
  Wallet,
  formatUnits,
  getAddress,
  isAddress,
  parseUnits,
} from "ethers";

import {
  formatPublicAccountBalanceLabel,
  listPublicAccountsWithBalance,
  resolveShieldSender,
  simulateTransactionOrThrow,
} from "../lib/shield-flow.js";
import { cliOptions } from "../utils/cli-command-options";
import { logCliJson, quietNonInteractive, runQuietSpinner } from "../utils/cli-quiet";
import { cliError, cliErrorFromCaught } from "../utils/cli-errors";
import { jsonStringifyWithBigInt } from "../utils/json-bigint";
import { readSeedKeystore } from "../utils/mnemonic";
import {
  DEFAULT_DATA_DIR,
  getRpcChainIdMatchingWallet,
  makeEthersProvider,
  resolveRpcUrl,
} from "../utils/rpc";
import { ERC20_ABI, resolveTokenMeta } from "../utils/tokens-util";
import {
  resolveWalletDir,
  resolveWalletNameOrPrompt,
  resolveWalletPassword,
} from "../utils/wallets-util";

type TransferOpts = {
  wallet?: string;
  password?: string;
  from?: string;
  fromPriv?: boolean;
  to?: string;
  token?: string;
  amountWei?: string;
  amountFormatted?: string;
  rpcUrl?: string;
  nonInteractive?: boolean;
  broadcast?: boolean;
  dataDir?: string;
};

type TxPayloadJson = {
  data: string;
  to: string;
  from: string;
  value: string;
};

const ERC20_TRANSFER_ABI = [
  "function transfer(address to, uint256 amount) returns (bool)",
] as const;

function etherscanTxUrl(chainId: bigint, txHash: string): string {
  const host = chainId === 11155111n ? "sepolia.etherscan.io" : "etherscan.io";
  return `https://${host}/tx/${txHash}`;
}

async function maybeConfirm(nonInteractive: boolean, message: string): Promise<void> {
  if (nonInteractive) return;
  const ok = await confirm({ message, default: false });
  if (!ok) {
    throw new Error("Cancelled by user.");
  }
}

function buildTransferTx(
  tokenMeta: { isEth: boolean; tokenAddress: string },
  recipient: string,
  amount: bigint
): { to: string; data: string; value: bigint } {
  if (tokenMeta.isEth) {
    return { to: recipient, data: "0x", value: amount };
  }
  const iface = new Interface(ERC20_TRANSFER_ABI);
  return {
    to: tokenMeta.tokenAddress,
    data: iface.encodeFunctionData("transfer", [recipient, amount]),
    value: 0n,
  };
}

function printTransferDryRunInteractive(
  tx: { to: string; data: string; value: bigint },
  tokenMeta: { symbol: string },
  senderAddress: string,
  recipient: string,
  amount: bigint,
  decimals: number
): void {
  const amountLabel = `${formatUnits(amount, decimals)} ${tokenMeta.symbol}`;
  console.log();
  console.log(chalk.bold("Planned transaction (not submitted)"));
  console.log(
    chalk.dim("Add --broadcast to sign and send this transaction on-chain from the CLI.")
  );
  console.log();
  console.log(chalk.dim(`Transfer ${amountLabel} from ${senderAddress} to ${recipient}`));
  const o: TxPayloadJson = {
    data: tx.data,
    to: tx.to,
    from: senderAddress,
    value: tx.value.toString(),
  };
  console.log(chalk.cyan("Transfer tx:"), jsonStringifyWithBigInt(o));
}

export function registerTransferCommand(program: Command): void {
  program
    .command("transfer")
    .description("Transfer ETH or ERC-20 between public accounts")
    .option("--wallet <name>", cliOptions.walletPickList)
    .option("--password <password>", cliOptions.password)
    .option("--from <address-or-index>", "Public sender address or public-account index")
    .option(
      "--from-priv",
      "With --broadcast: derive --from index from mnemonic when missing from public accounts"
    )
    .option("--to <address>", "Recipient address")
    .option(
      "--broadcast",
      "Sign and submit on-chain (omit to simulate / print transaction payload only)"
    )
    .option("--token <address|symbol|eth>", "Token address or symbol (default: eth)")
    .option("--amount-wei <amount>", "Raw token amount in wei/base units")
    .option("--amount-formatted <amount>", "Decimal amount (converted using token decimals)")
    .option("--rpc-url <url>", cliOptions.rpcUrl)
    .option("--non-interactive", cliOptions.nonInteractiveShieldLike)
    .option("--dataDir <path>", cliOptions.dataDir)
    .action(async (opts: TransferOpts) => {
      if (opts.amountWei && opts.amountFormatted) {
        cliError("Provide only one of --amount-wei or --amount-formatted.");
        return;
      }

      const rpcUrl = resolveRpcUrl(opts.rpcUrl);
      if (!rpcUrl) {
        cliError("Missing --rpc-url (or environment variable RPC_URL).");
        return;
      }

      const dataDir = opts.dataDir ?? DEFAULT_DATA_DIR;
      const walletName = await resolveWalletNameOrPrompt({
        dataDir,
        wallet: opts.wallet,
        nonInteractive: opts.nonInteractive,
      });
      if (!walletName) return;

      let walletDir: string;
      try {
        walletDir = resolveWalletDir(dataDir, walletName);
      } catch (e) {
        cliErrorFromCaught(e);
        return;
      }

      const password = await resolveWalletPassword({
        flagPassword: opts.password,
        nonInteractive: opts.nonInteractive,
        validate: (candidate) => {
          readSeedKeystore(candidate, walletDir);
        },
      });
      if (!password) return;

      let mnemonic: string;
      try {
        mnemonic = readSeedKeystore(password, walletDir);
      } catch (e) {
        cliErrorFromCaught(e);
        return;
      }

      let chainId: bigint;
      try {
        chainId = await getRpcChainIdMatchingWallet(rpcUrl, walletDir);
      } catch (e) {
        cliErrorFromCaught(e);
        return;
      }

      let tokenMeta: Awaited<ReturnType<typeof resolveTokenMeta>>;
      try {
        tokenMeta = await resolveTokenMeta(opts.token, rpcUrl, chainId);
      } catch (e) {
        cliErrorFromCaught(e);
        return;
      }

      let amount: bigint | null = null;
      if (opts.amountWei) {
        amount = BigInt(opts.amountWei);
      } else if (opts.amountFormatted) {
        amount = parseUnits(opts.amountFormatted, tokenMeta.decimals);
      }
      if (amount !== null && amount <= 0n) {
        cliError("Amount must be greater than zero.");
        return;
      }

      const broadcast = !!opts.broadcast;
      const dryRun = !broadcast;

      let fromValue = opts.from ?? "";
      let toValue = opts.to ?? "";

      if (!fromValue && opts.nonInteractive) {
        cliError("Missing --from in non-interactive mode.");
        return;
      }
      if (!toValue && opts.nonInteractive) {
        cliError("Missing --to in non-interactive mode.");
        return;
      }
      if (amount === null && opts.nonInteractive) {
        cliError(
          "Missing amount in non-interactive mode. Provide --amount-wei or --amount-formatted."
        );
        return;
      }

      const withBalances = await listPublicAccountsWithBalance(
        rpcUrl,
        walletDir,
        mnemonic,
        password,
        tokenMeta
      );

      try {
        if (amount === null) {
          if (withBalances.length === 0) {
            cliError(
              "No public accounts found in this wallet. Create one with next-fresh-address first."
            );
            return;
          }

          console.log();
          console.log(
            chalk.bold(`Available accounts (${tokenMeta.symbol} balances):`)
          );
          for (const acct of withBalances) {
            console.log(
              `  [${acct.index}] ${acct.address}  ${formatPublicAccountBalanceLabel(acct, tokenMeta)}`
            );
          }

          const amountFormattedInput = await input({
            message: `Amount to transfer (${tokenMeta.symbol}, formatted):`,
            validate: (value) => {
              if (!value.trim()) return "Amount is required.";
              try {
                const parsed = parseUnits(value.trim(), tokenMeta.decimals);
                if (parsed <= 0n) return "Amount must be greater than zero.";
              } catch {
                return `Invalid ${tokenMeta.symbol} amount format.`;
              }
              return true;
            },
          });
          amount = parseUnits(amountFormattedInput.trim(), tokenMeta.decimals);
        }
        if (amount === null) {
          cliError("Amount is required.");
          return;
        }

        if (!fromValue) {
          const candidates = withBalances.filter((x) => x.balance >= amount!);
          if (candidates.length === 0) {
            const needed = formatUnits(amount, tokenMeta.decimals);
            cliError(
              `No public account has enough ${tokenMeta.symbol}. Required: ${needed} ${tokenMeta.symbol}.`
            );
            return;
          }

          const chosen = await select<string>({
            message: `Pick source account (${tokenMeta.symbol})`,
            choices: candidates.map((acct) => ({
              value: acct.address,
              name: `[${acct.index}] ${acct.address}  (${formatPublicAccountBalanceLabel(acct, tokenMeta)}, need ${formatUnits(amount!, tokenMeta.decimals)} ${tokenMeta.symbol})`,
            })),
          });
          fromValue = chosen;
        }

        if (!toValue) {
          toValue = await input({
            message: "Recipient address:",
            validate: (value) => {
              if (!value.trim()) return "Recipient is required.";
              if (!isAddress(value.trim())) return "Invalid Ethereum address.";
              return true;
            },
          });
          toValue = toValue.trim();
        }
      } catch (e) {
        cliErrorFromCaught(e);
        return;
      }

      if (!isAddress(toValue)) {
        cliError("--to must be a valid Ethereum address.");
        return;
      }
      const recipient = getAddress(toValue);

      let senderAddress: string;
      let senderPrivateKey: string | undefined;
      try {
        const resolved = resolveShieldSender({
          fromValue,
          walletDir,
          mnemonic,
          password,
          dryRun,
          allowDeriveFromMnemonic: !!opts.fromPriv,
        });
        senderAddress = resolved.senderAddress;
        senderPrivateKey = resolved.senderPrivateKey;
      } catch (e) {
        cliErrorFromCaught(e);
        return;
      }

      if (recipient.toLowerCase() === senderAddress.toLowerCase()) {
        cliError("Sender and recipient must be different addresses.");
        return;
      }

      const tx = buildTransferTx(tokenMeta, recipient, amount);
      const rpc = await makeEthersProvider(rpcUrl);
      const txSpinner = spinner();
      const quiet = quietNonInteractive(opts.nonInteractive);
      const amountPreview = `${formatUnits(amount, tokenMeta.decimals)} ${tokenMeta.symbol}`;

      try {
        if (dryRun) {
          await simulateTransactionOrThrow(
            rpc,
            {
              to: tx.to,
              from: senderAddress,
              data: tx.data,
              value: tx.value,
            },
            "Transfer transaction"
          );

          const payload: TxPayloadJson = {
            data: tx.data,
            to: tx.to,
            from: senderAddress,
            value: tx.value.toString(),
          };

          if (opts.nonInteractive) {
            logCliJson({
              recipient,
              amount: amount.toString(),
              token: tokenMeta.isEth ? "eth" : tokenMeta.tokenAddress,
              transaction: payload,
            });
          } else {
            printTransferDryRunInteractive(
              tx,
              tokenMeta,
              senderAddress,
              recipient,
              amount,
              tokenMeta.decimals
            );
            console.log(chalk.green("✔ Transfer simulation succeeded."));
          }
          return;
        }

        if (!senderPrivateKey) {
          cliError(
            "Cannot sign: no private key for this --from (use a saved public account or --from-priv with --broadcast)."
          );
          return;
        }

        await simulateTransactionOrThrow(
          rpc,
          {
            to: tx.to,
            from: senderAddress,
            data: tx.data,
            value: tx.value,
          },
          "Transfer transaction"
        );

        await maybeConfirm(
          !!opts.nonInteractive,
          `Send transfer: ${amountPreview} from ${senderAddress} to ${recipient}?`
        );

        const signer = new Wallet(senderPrivateKey, rpc);
        const sent = await runQuietSpinner(
          quiet,
          txSpinner,
          { start: "Sending transfer...", failure: "Transfer failed." },
          async () => {
            if (tokenMeta.isEth) {
              const t = await signer.sendTransaction({
                to: recipient,
                value: amount,
                data: "0x",
              });
              await t.wait();
              return t;
            }
            const erc20 = new Contract(tokenMeta.tokenAddress, ERC20_ABI, signer);
            const t = await erc20.transfer(recipient, amount);
            await t.wait();
            return t;
          },
          (t) => `Transfer mined: ${t.hash}`
        );

        if (opts.nonInteractive) {
          logCliJson({
            hash: sent.hash,
            explorer: etherscanTxUrl(chainId, sent.hash),
            from: senderAddress,
            to: recipient,
            amount: amount.toString(),
            token: tokenMeta.isEth ? "eth" : tokenMeta.tokenAddress,
          });
        } else {
          console.log();
          console.log(chalk.green("✔ Transfer complete."));
          console.log(chalk.dim(etherscanTxUrl(chainId, sent.hash)));
        }
      } catch (e) {
        cliErrorFromCaught(e);
      } finally {
        rpc.destroy();
      }
    });
}
