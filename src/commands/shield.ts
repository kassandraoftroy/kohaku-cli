import { confirm, input, select } from "@inquirer/prompts";
import { spinner } from "@clack/prompts";
import chalk from "chalk";
import type { AssetAmount } from "@kohaku-eth/plugins";
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
import { Mnemonic } from "derive-railgun-keys";

import { makeHost } from "../host/makeHost";
import { cliOptions } from "../utils/cli-command-options";
import { cliError, cliErrorFromCaught } from "../utils/cli-errors";
import { jsonStringifyWithBigInt } from "../utils/json-bigint";
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
import { readSeedKeystore } from "../utils/mnemonic";
import { makePublicAccountsStorage } from "../utils/public-accounts";
import {
  assertPpErc20TokenWhitelisted,
  createProtocolPlugin,
  ETH_AS_ERC20,
  isSupportedProtocol,
  pluginIdForProtocol,
  type SupportedProtocol,
} from "../utils/plugins";

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
  broadcast?: boolean;
  dataDir?: string;
};

type FeeOverrides = {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
};

type PublicAccountWithBalance = {
  index: number;
  address: string;
  priv: string;
  balance: bigint;
};

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

function encodeErc20ApproveTx(
  tokenAddress: string,
  spender: string,
  amount: bigint
): { to: string; data: string; value: bigint } {
  const iface = new Interface(ERC20_ABI);
  const data = iface.encodeFunctionData("approve", [spender, amount]);
  return { to: tokenAddress, data, value: 0n };
}

type TxPayloadJson = {
  data: string;
  to: string;
  from: string;
  value: string;
};

type BroadcastTxResultJson = {
  type: "approval" | "shield";
  hash: string;
};

async function simulateTransactionOrThrow(
  rpc: Awaited<ReturnType<typeof makeEthersProvider>>,
  tx: { to: string; from: string; data: string; value: bigint; gasLimit?: bigint },
  stepLabel: string
): Promise<void> {
  try {
    await rpc.call({
      to: tx.to,
      from: tx.from,
      data: tx.data,
      value: tx.value,
      gasLimit: tx.gasLimit,
    });
  } catch (e) {
    const msg =
      e instanceof Error
        ? e.message
        : `Simulation failed with non-Error value: ${jsonStringifyWithBigInt(e)}`;
    throw new Error(`${stepLabel} simulation failed: ${msg}`);
  }
}

function printShieldDryRunInteractive(
  shieldTx: { to: string; data: string; value: bigint },
  approve: { to: string; data: string; value: bigint } | null,
  tokenMeta: { symbol: string },
  senderAddress: string
): void {
  console.log();
  console.log(chalk.bold("Planned transactions (not submitted)"));
  console.log(
    chalk.dim("Add --broadcast to sign and send these transactions on-chain from the CLI.")
  );
  console.log();
  if (approve) {
    const o: TxPayloadJson = {
      data: approve.data,
      to: approve.to,
      from: senderAddress,
      value: approve.value.toString(),
    };
    console.log(
      chalk.cyan(`Approve ${tokenMeta.symbol} ERC20 tx (1/2):`),
      jsonStringifyWithBigInt(o)
    );
    console.log();
  }
  const o: TxPayloadJson = {
    data: shieldTx.data,
    to: shieldTx.to,
    from: senderAddress,
    value: shieldTx.value.toString(),
  };
  const label = approve
    ? "Shield operation tx (2/2)"
    : "Shield operation tx (1/1)";
  console.log(chalk.cyan(`${label}:`), jsonStringifyWithBigInt(o));
}

function toShieldTxs(op: unknown): Array<{ to: string; data: string; value: bigint }> {
  let txs: Array<{ to: string; data: string; value: bigint }> | null = null;

  if (Array.isArray(op)) {
    txs = op as Array<{ to: string; data: string; value: bigint }>;
  } else if (
    typeof op === "object" &&
    op !== null &&
    "txns" in op &&
    Array.isArray((op as { txns?: unknown[] }).txns)
  ) {
    txs = (op as { txns: Array<{ to: string; data: string; value: bigint }> }).txns;
  }

  if (!txs) {
    throw new Error("Unsupported shield operation shape returned by plugin.");
  }

  if (txs.length !== 1) {
    throw new Error(
      `Expected prepareShield() to return exactly 1 tx, got ${txs.length}.`
    );
  }
  return txs;
}

export function registerShieldCommand(program: Command): void {
  program
    .command("shield")
    .description("Shield public funds into a privacy protocol")
    .requiredOption("--protocol <protocol>", "Protocol: railgun | privacy-pools")
    .option("--wallet <name>", cliOptions.walletPickList)
    .option("--password <password>", cliOptions.password)
    .option("--from <address-or-index>", "Public sender address or public-account index")
    .option(
      "--from-priv",
      "With --broadcast: derive --from index from mnemonic when missing from public accounts (not required for dry-run)"
    )
    .option(
      "--broadcast",
      "Sign and submit on-chain (omit to print transaction payloads only)"
    )
    .option("--token <address|eth>", "Token address (default: eth)")
    .option("--amount-wei <amount>", "Raw token amount in wei/base units")
    .option("--amount-formatted <amount>", "Decimal amount (converted using token decimals)")
    .option("--rpc-url <url>", cliOptions.rpcUrl)
    .option("--base-fee-gwei <gwei>", "Base fee (gwei)")
    .option("--priority-fee-gwei <gwei>", "Priority fee (gwei)")
    .option("--non-interactive", cliOptions.nonInteractiveShieldLike)
    .option("--dataDir <path>", cliOptions.dataDir)
    .action(async (opts: ShieldOpts) => {
      if (!isSupportedProtocol(opts.protocol)) {
        cliError('--protocol must be "railgun" or "privacy-pools".');
        return;
      }
      const protocol = opts.protocol;

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
      let fromValue = opts.from ?? "";

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
        tokenMeta = await resolveTokenMeta(opts.token, rpcUrl);
      } catch (e) {
        cliErrorFromCaught(e);
        return;
      }

      if (protocol === "privacy-pools" && !tokenMeta.isEth) {
        try {
          assertPpErc20TokenWhitelisted(chainId, tokenMeta.tokenAddress);
        } catch (e) {
          cliErrorFromCaught(e);
          return;
        }
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

      if (!fromValue && opts.nonInteractive) {
        cliError("Missing --from in non-interactive mode.");
        return;
      }
      if (amount === null && opts.nonInteractive) {
        cliError(
          "Missing amount in non-interactive mode. Provide --amount-wei or --amount-formatted."
        );
        return;
      }

      const publicStorage = makePublicAccountsStorage(walletDir, mnemonic, password);
      const allPublicAccounts = publicStorage.getAccounts();

      const rpcForSelection = await makeEthersProvider(rpcUrl);
      try {
        const withBalances: PublicAccountWithBalance[] = [];
        for (const acct of allPublicAccounts) {
          const bal = tokenMeta.isEth
            ? await rpcForSelection.getBalance(acct.address)
            : await new Contract(
                tokenMeta.tokenAddress,
                ERC20_ABI,
                rpcForSelection
              ).balanceOf(acct.address);
          withBalances.push({
            index: acct.index,
            address: acct.address,
            priv: acct.priv,
            balance: bal,
          });
        }

        if (amount === null) {
          if (opts.nonInteractive) {
            cliError(
              "Missing amount in non-interactive mode. Provide --amount-wei or --amount-formatted."
            );
            return;
          }

          if (withBalances.length === 0) {
            cliError(
              "No public accounts found in this wallet. Create one with nextFreshAddress first."
            );
            return;
          }

          console.log();
          console.log(
            chalk.bold(`Available accounts (${tokenMeta.symbol} balances):`)
          );
          for (const acct of withBalances) {
            console.log(
              `  [${acct.index}] ${acct.address}  ${formatUnits(acct.balance, tokenMeta.decimals)} ${tokenMeta.symbol}`
            );
          }

          const amountFormattedInput = await input({
            message: `Amount to shield (${tokenMeta.symbol}, formatted):`,
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
          if (opts.nonInteractive) {
            cliError("Missing --from in non-interactive mode.");
            return;
          }

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
              name: `[${acct.index}] ${acct.address}  (${formatUnits(acct.balance, tokenMeta.decimals)} ${tokenMeta.symbol}, need ${formatUnits(amount!, tokenMeta.decimals)})`,
            })),
          });
          fromValue = chosen;
        }
      } finally {
        rpcForSelection.destroy();
      }

      const fromIndex = parseFromIndex(fromValue);
      let senderPrivateKey: string | undefined;
      let senderAddress: string;
      if (fromIndex !== null) {
        const account = publicStorage.getAccount(fromIndex);
        if (account) {
          senderPrivateKey = account.priv;
          senderAddress = account.address;
        } else if (opts.fromPriv || dryRun) {
          senderPrivateKey = Mnemonic.to0xPrivateKeyByIndex(mnemonic, fromIndex);
          senderAddress = new Wallet(senderPrivateKey).address;
        } else {
          cliError(
            `Public account index ${fromIndex} not found. Use --from-priv with --broadcast to derive from mnemonic, or omit --broadcast for a dry-run.`
          );
          return;
        }
      } else if (isAddress(fromValue)) {
        senderAddress = getAddress(fromValue);
        const match = publicStorage
          .getAccounts()
          .find((x) => x.address.toLowerCase() === senderAddress.toLowerCase());
        if (match) {
          senderPrivateKey = match.priv;
        } else if (dryRun) {
          senderPrivateKey = undefined;
        } else {
          cliError(
            `Address ${senderAddress} is not in this wallet's public accounts. Use --broadcast with --from-priv and an index, or omit --broadcast to preview txs for this address.`
          );
          return;
        }
      } else {
        cliError("--from must be either a valid address or a non-negative index.");
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
          pluginId: pluginIdForProtocol(protocol),
        });
        const plugin = await createProtocolPlugin(protocol, host, chainId);

        const asset = tokenMeta.isEth && protocol === "railgun"
          ? {
              asset: { __type: "native" },
              amount,
            }
          : {
              asset: {
                __type: "erc20",
                contract: (tokenMeta.isEth
                  ? ETH_AS_ERC20
                  : tokenMeta.tokenAddress) as `0x${string}`,
              },
              amount,
            };
        let tx: { to: string; data: string; value: bigint };
        try {
          const op = await plugin.prepareShield(asset as AssetAmount);
          tx = toShieldTxs(op)[0]!;
        } catch (e) {
          const msg = e instanceof Error ? e.message : JSON.stringify(e);
          cliError(msg);
          return;
        }

        if (dryRun) {
          let approve: { to: string; data: string; value: bigint } | null = null;
          if (!tokenMeta.isEth) {
            const erc20Read = new Contract(
              tokenMeta.tokenAddress,
              ERC20_ABI,
              rpcForHost
            );
            const allowance: bigint = await erc20Read.allowance(
              senderAddress,
              tx.to
            );
            if (allowance < amount) {
              approve = encodeErc20ApproveTx(
                tokenMeta.tokenAddress,
                tx.to,
                amount
              );
            }
          }
          const transactions: TxPayloadJson[] = [];
          if (approve) {
            transactions.push({
              data: approve.data,
              to: approve.to,
              from: senderAddress,
              value: approve.value.toString(),
            });
          }
          transactions.push({
            data: tx.data,
            to: tx.to,
            from: senderAddress,
            value: tx.value.toString(),
          });
          if (opts.nonInteractive) {
            console.log(jsonStringifyWithBigInt({ transactions }));
          } else {
            printShieldDryRunInteractive(tx, approve, tokenMeta, senderAddress);
            console.log(chalk.green("✔ Shield dry run complete."));
          }
          return;
        }

        if (!senderPrivateKey) {
          cliError(
            "Cannot sign: no private key for this --from (use a saved public account or --from-priv with --broadcast)."
          );
          return;
        }

        const signer = new Wallet(senderPrivateKey, rpcForHost);
        // const feeOverrides = await computeFees(rpcUrl, opts);
        const amountPreview = `${formatUnits(amount, tokenMeta.decimals)} ${tokenMeta.symbol}`;
        const broadcastTransactions: BroadcastTxResultJson[] = [];

        let hasApproval = false;
        if (!tokenMeta.isEth) {
          const erc20 = new Contract(tokenMeta.tokenAddress, ERC20_ABI, signer);
          const allowance: bigint = await erc20.allowance(senderAddress, tx.to);
          if (allowance < amount) {
            hasApproval = true;
            await simulateTransactionOrThrow(
              rpcForHost,
              {
                to: tokenMeta.tokenAddress,
                from: senderAddress,
                data: encodeErc20ApproveTx(tokenMeta.tokenAddress, tx.to, amount).data,
                value: 0n,
              },
              "Approval transaction"
            );
            await maybeConfirm(
              !!opts.nonInteractive,
              `Send approval transaction (1/2): approve ${tx.to} to spend ${amountPreview} ${tokenMeta.symbol} (from ${senderAddress})?`
            );
            if (!opts.nonInteractive) {
              txSpinner.start("Sending approval 1/2...");
            }
            const approveTx = await erc20.approve(tx.to, amount/*, feeOverrides*/);
            await approveTx.wait();
            broadcastTransactions.push({ type: "approval", hash: approveTx.hash });
            if (!opts.nonInteractive) {
              txSpinner.stop(`Approval mined (1/2): ${approveTx.hash}`);
            }
          }
        }

        const shieldStep = hasApproval ? "2/2" : "1/1";
        await maybeConfirm(
          !!opts.nonInteractive,
          `Send shield transaction (${shieldStep}): shield ${amountPreview} ${tokenMeta.symbol} (from ${senderAddress})?`
        );
        await simulateTransactionOrThrow(
          rpcForHost,
          {
            to: tx.to,
            from: senderAddress,
            data: tx.data,
            value: tx.value,
            gasLimit: 2000000n,
          },
          "Shield transaction"
        );
        if (!opts.nonInteractive) {
          txSpinner.start(`Sending shield tx ${shieldStep}...`);
        }

        const sent = await signer.sendTransaction({
          to: tx.to,
          data: tx.data,
          value: tx.value,
          gasLimit: 2000000,
          // ...feeOverrides,
        });
        await sent.wait();
        broadcastTransactions.push({ type: "shield", hash: sent.hash });
        if (!opts.nonInteractive) {
          txSpinner.stop(`Shield tx mined (${shieldStep}): ${sent.hash}`);
        } else {
          console.log(
            jsonStringifyWithBigInt({ transactions: broadcastTransactions })
          );
          return;
        }
      } catch (e) {
        cliErrorFromCaught(e);
        return;
      } finally {
        rpcForHost.destroy();
      }

      if (!opts.nonInteractive) {
        console.log(chalk.green("✔ Shield flow completed."));
      }
    });
}
