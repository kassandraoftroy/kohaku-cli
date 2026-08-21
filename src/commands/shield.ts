import { confirm, input, select } from "@inquirer/prompts";
import { spinner } from "@clack/prompts";
import chalk from "chalk";
import type { AssetAmount } from "@kohaku-eth/plugins";
import type { Command } from "commander";
import { formatUnits, getAddress, isAddress, parseUnits } from "viem";
import { Mnemonic } from "derive-railgun-keys";

import { makeHost } from "../host/makeHost";
import {
  buildShieldCallList,
  formatPublicAccountBalanceLabel,
  listPublicAccountsWithBalance,
  partitionShieldTxs,
  resolveShieldApprovalCalls,
  shieldTransactionConfirmMessage,
  summarizeMultiShieldPlan,
  toShieldTxs,
} from "../lib/shield-flow.js";
import { cliOptions } from "../utils/cli-command-options";
import {
  logCliJson,
  manageSpinner,
  quietNonInteractive,
  runQuietSpinner,
} from "../utils/cli-quiet";
import { cliError, cliErrorFromCaught } from "../utils/cli-errors";
import {
  estimateEip7702BatchUserOpFee,
  needsSimple7702Authorization,
  sendEip7702BatchUserOperation,
} from "../utils/eip7702-batch-userop.js";
import {
  estimateEoaTxFeePreview,
  feeConfirmLine,
  printFeePreview,
  type FeePreview,
} from "../utils/fee-preview.js";
import { resolveAddressOrName } from "../utils/resolve-name.js";
import {
  addressFromPrivateKey,
  makeWalletClient,
  sendTransactionAndWait,
  simulateCallOrThrow,
} from "../utils/viem-tx.js";
import { jsonStringifyWithBigInt } from "../utils/json-bigint";
import {
  DEFAULT_DATA_DIR,
  getRpcChainIdMatchingWallet,
  makePublicClient,
  disposePublicClient,
  resolveRpcUrl,
  type KohakuPublicClient,
} from "../utils/rpc";
import { SIMPLE_7702_IMPLEMENTATION } from "../utils/simple-7702.js";
import { withTor } from "../utils/tor";
import {
  runWithSyncProgress,
  syncPluginWithProgress,
} from "../utils/sync-progress.js";
import { resolveTokenMeta } from "../utils/tokens-util";
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
  pluginIdForProtocol,
  prepareProtocolShield,
  railgunErc20AssetAmount,
  resolveProtocolOption,
  SUPPORTED_PROTOCOLS_HELP,
  type SupportedProtocol,
} from "../utils/plugins";
import {
  assertTornadoDepositAmount,
  assertTornadoTokenSupported,
} from "../utils/tornado-pools.js";

type ShieldOpts = {
  protocol?: string;
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
  withoutTor?: boolean;
  dataDir?: string;
};

type TxPayloadJson = {
  data: string;
  to: string;
  from: string;
  value: string;
};

type BroadcastTxResultJson = {
  type: "approval" | "shield" | "eip7702-userop";
  hash: string;
  userOpHash?: string;
};

function etherscanTxUrl(chainId: bigint, txHash: string): string {
  const host = chainId === 11155111n ? "sepolia.etherscan.io" : "etherscan.io";
  return `https://${host}/tx/${txHash}`;
}

function parseFromIndex(fromValue: string): number | null {
  if (!/^\d+$/.test(fromValue)) return null;
  const parsed = Number(fromValue);
  if (!Number.isInteger(parsed) || parsed < 0) return null;
  return parsed;
}

async function maybeConfirm(
  nonInteractive: boolean,
  message: string,
  spin?: { active: boolean; stop: (msg?: string, code?: number) => void }
): Promise<void> {
  if (nonInteractive) return;
  // Stop any clack spinner before @inquirer draws (same as unshield).
  if (spin?.active) spin.stop();
  console.log();
  const ok = await confirm({ message, default: false });
  if (!ok) {
    throw new Error("Cancelled by user.");
  }
}

async function simulateTransactionOrThrow(
  client: KohakuPublicClient,
  tx: { to: string; from: string; data: string; value: bigint; gasLimit?: bigint },
  stepLabel: string
): Promise<void> {
  try {
    await simulateCallOrThrow(
      client,
      {
        to: tx.to,
        from: tx.from,
        data: tx.data,
        value: tx.value,
        gas: tx.gasLimit,
      },
      stepLabel
    );
  } catch (e) {
    const msg =
      e instanceof Error
        ? e.message
        : `Simulation failed with non-Error value: ${jsonStringifyWithBigInt(e)}`;
    throw new Error(`${stepLabel} simulation failed: ${msg}`);
  }
}

function printShieldDryRunInteractive(
  calls: Array<{ to: string; data: string; value: bigint }>,
  approvalsCount: number,
  tokenMeta: { symbol: string; decimals: number },
  senderAddress: string,
  batchAsUserOp: boolean
): void {
  console.log();
  console.log(
    chalk.bold(
      batchAsUserOp
        ? "Planned EIP-7702 UserOperation (not submitted)"
        : "Planned transactions (not submitted)"
    )
  );
  console.log(
    chalk.dim(
      batchAsUserOp
        ? "Add --broadcast to submit all calls as a single Pimlico UserOp (EIP-7702 Simple7702Account)."
        : "Add --broadcast to sign and send these transactions on-chain from the CLI."
    )
  );
  console.log();
  console.log(chalk.dim(`Sender: ${senderAddress}`));
  if (batchAsUserOp) {
    console.log(chalk.dim(`Implementation: ${SIMPLE_7702_IMPLEMENTATION}`));
    console.log(
      chalk.dim(
        `Calls: ${calls.length} (${approvalsCount} approval(s) + ${calls.length - approvalsCount} shield)`
      )
    );
  }
  for (let i = 0; i < calls.length; i++) {
    const call = calls[i]!;
    const isApprove = i < approvalsCount;
    const o: TxPayloadJson = {
      data: call.data,
      to: call.to,
      from: senderAddress,
      value: call.value.toString(),
    };
    const valueLabel =
      !isApprove && call.value > 0n
        ? ` — ${formatUnits(call.value, tokenMeta.decimals)} ${tokenMeta.symbol}`
        : "";
    console.log(
      chalk.cyan(
        `${isApprove ? "Approve" : "Shield"} call (${i + 1}/${calls.length})${valueLabel}:`
      ),
      jsonStringifyWithBigInt(o)
    );
  }
}

export function registerShieldCommand(program: Command): void {
  program
    .command("shield")
    .description(
      "Shield public funds into a privacy protocol (2+ calls → one EIP-7702 UserOp via Pimlico)"
    )
    .option(
      "--protocol <protocol>",
      `Protocol: ${SUPPORTED_PROTOCOLS_HELP} (or set DEFAULT_PRIVACY_PROTOCOL)`
    )
    .option("--wallet <name>", cliOptions.walletPickList)
    .option("--password <password>", cliOptions.password)
    .option("--from <address-or-index>", "Public sender address or public-account index")
    .option(
      "--from-priv",
      "With --broadcast: derive --from index from mnemonic when missing from public accounts (not required for dry-run)"
    )
    .option(
      "--broadcast",
      "Sign and submit on-chain (one EOA tx, or one EIP-7702 UserOp when 2+ calls)"
    )
    .option("--token <address|symbol|eth>", "Token address or symbol (default: eth)")
    .option("--amount-wei <amount>", "Raw token amount in wei/base units")
    .option("--amount-formatted <amount>", "Decimal amount (converted using token decimals)")
    .option("--rpc-url <url>", cliOptions.rpcUrl)
    .option("--base-fee-gwei <gwei>", "Base fee (gwei)")
    .option("--priority-fee-gwei <gwei>", "Priority fee (gwei)")
    .option("--non-interactive", cliOptions.nonInteractiveShieldLike)
    .option("--without-tor", cliOptions.withoutTor)
    .option("--dataDir <path>", cliOptions.dataDir)
    .action(async (opts: ShieldOpts) => {
      const resolvedProtocol = resolveProtocolOption(opts.protocol);
      if (!resolvedProtocol.ok) {
        cliError(
          resolvedProtocol.error === "invalid"
            ? `--protocol must be "${SUPPORTED_PROTOCOLS_HELP}".`
            : `--protocol is required (or set DEFAULT_PRIVACY_PROTOCOL to ${SUPPORTED_PROTOCOLS_HELP}).`
        );
        return;
      }
      const protocol = resolvedProtocol.protocol;

      if (opts.amountWei && opts.amountFormatted) {
        cliError("Provide only one of --amount-wei or --amount-formatted.");
        return;
      }

      const rpcUrl = resolveRpcUrl(opts.rpcUrl);

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
        tokenMeta = await resolveTokenMeta(opts.token, rpcUrl, chainId);
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
      if (protocol === "tornado") {
        try {
          assertTornadoTokenSupported(chainId, {
            isEth: tokenMeta.isEth,
            tokenAddress: tokenMeta.tokenAddress,
            symbol: tokenMeta.symbol,
          });
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
      if (amount !== null && protocol === "tornado") {
        try {
          assertTornadoDepositAmount(chainId, amount, {
            isEth: tokenMeta.isEth,
            tokenAddress: tokenMeta.tokenAddress,
            symbol: tokenMeta.symbol,
            decimals: tokenMeta.decimals,
          });
        } catch (e) {
          cliErrorFromCaught(e);
          return;
        }
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

      const withBalances = await listPublicAccountsWithBalance(
        rpcUrl,
        walletDir,
        mnemonic,
        password,
        tokenMeta
      );

      try {
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
              `  [${acct.index}] ${acct.address}  ${formatPublicAccountBalanceLabel(acct, tokenMeta)}`
            );
          }

          const amountFormattedInput = await input({
            message: `Amount to shield (${tokenMeta.symbol}, formatted):`,
            validate: (value) => {
              if (!value.trim()) return "Amount is required.";
              try {
                const parsed = parseUnits(value.trim(), tokenMeta.decimals);
                if (parsed <= 0n) return "Amount must be greater than zero.";
                if (protocol === "tornado") {
                  assertTornadoDepositAmount(chainId, parsed, {
                    isEth: tokenMeta.isEth,
                    tokenAddress: tokenMeta.tokenAddress,
                    symbol: tokenMeta.symbol,
                    decimals: tokenMeta.decimals,
                  });
                }
              } catch (e) {
                return e instanceof Error
                  ? e.message
                  : `Invalid ${tokenMeta.symbol} amount format.`;
              }
              return true;
            },
          });
          amount = parseUnits(amountFormattedInput.trim(), tokenMeta.decimals);
          if (protocol === "tornado") {
            try {
              assertTornadoDepositAmount(chainId, amount, {
                isEth: tokenMeta.isEth,
                tokenAddress: tokenMeta.tokenAddress,
                symbol: tokenMeta.symbol,
                decimals: tokenMeta.decimals,
              });
            } catch (e) {
              cliErrorFromCaught(e);
              return;
            }
          }
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
              name: `[${acct.index}] ${acct.address}  (${formatPublicAccountBalanceLabel(acct, tokenMeta)}, need ${formatUnits(amount!, tokenMeta.decimals)} ${tokenMeta.symbol})`,
            })),
          });
          fromValue = chosen;
        }
      } catch (e) {
        cliErrorFromCaught(e);
        return;
      }

      // Resolve ENS / GNS / WNS names to addresses before the index/address branch.
      if (fromValue && parseFromIndex(fromValue) === null && !isAddress(fromValue)) {
        try {
          fromValue = await resolveAddressOrName(fromValue, rpcUrl);
        } catch (e) {
          cliErrorFromCaught(e);
          return;
        }
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
          senderAddress = addressFromPrivateKey(senderPrivateKey);
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

      const rpcForHost = await makePublicClient(rpcUrl);
      const txSpinner = manageSpinner(
        spinner(),
        quietNonInteractive(opts.nonInteractive)
      );
      const quiet = quietNonInteractive(opts.nonInteractive);
      const broadcastTransactions: BroadcastTxResultJson[] = [];
      try {
        await withTor(
          !opts.withoutTor,
          {
            rpcUrl,
            walletDir,
            onStatus: (message) => {
              txSpinner.start(message);
            },
          },
          async () => {
        // Tor onStatus leaves the spinner running; stop before prepare / prompts.
        if (txSpinner.active) txSpinner.stop("Tor ready.");

        const host = await makeHost({
          rpc: rpcForHost,
          walletDir,
          password,
          mnemonic,
          pluginId: pluginIdForProtocol(protocol),
          chainId,
        });
        const plugin = await createProtocolPlugin(protocol, host, chainId);

        const asset =
          protocol === "railgun"
            ? tokenMeta.isEth
              ? {
                  asset: { __type: "native" as const },
                  amount,
                }
              : railgunErc20AssetAmount(tokenMeta.tokenAddress, amount)
            : {
                asset: {
                  __type: "erc20",
                  contract: (tokenMeta.isEth
                    ? ETH_AS_ERC20
                    : tokenMeta.tokenAddress) as `0x${string}`,
                },
                amount,
              };
        let shieldTxs: Array<{ to: string; data: string; value: bigint }>;
        let approvals: Array<{ to: string; data: string; value: bigint }> = [];
        try {
          const op =
            protocol === "railgun"
              ? await prepareProtocolShield(plugin, protocol, asset as AssetAmount)
              : await runWithSyncProgress(
                  {
                    protocol,
                    onUpdate: quiet ? undefined : (message) => txSpinner.start(message),
                  },
                  async () => {
                    await syncPluginWithProgress(plugin, protocol);
                    return prepareProtocolShield(
                      plugin,
                      protocol,
                      asset as AssetAmount
                    );
                  }
                );
          if (protocol !== "railgun" && txSpinner.active) {
            txSpinner.stop("Private state synced.");
          }
          const rawTxs = toShieldTxs(op);
          if (tokenMeta.isEth) {
            shieldTxs = partitionShieldTxs(rawTxs).deposits;
          } else {
            const resolved = await resolveShieldApprovalCalls({
              client: rpcForHost,
              tokenAddress: tokenMeta.tokenAddress,
              senderAddress,
              amount,
              shieldTxs: rawTxs,
            });
            approvals = resolved.approvals;
            shieldTxs = resolved.deposits;
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : JSON.stringify(e);
          cliError(msg);
          return;
        }

        const calls = buildShieldCallList(approvals, shieldTxs);
        const batchAsUserOp = calls.length > 1;
        const amountPreview = `${formatUnits(amount, tokenMeta.decimals)} ${tokenMeta.symbol}`;

        // Single EOA tx: eth_call is fine. Multi-call UserOp: do NOT eth_call each
        // payload alone (approve→deposit etc. false-positive). Batch validation is
        // bundler prepareUserOperation / estimateUserOperationGas below.
        if (!batchAsUserOp) {
          const call = calls[0]!;
          await simulateTransactionOrThrow(
            rpcForHost,
            {
              to: call.to,
              from: senderAddress,
              data: call.data,
              value: call.value,
            },
            "Shield transaction"
          );
        }

        let fees: FeePreview;
        if (batchAsUserOp) {
          fees = await estimateEip7702BatchUserOpFee({
            client: rpcForHost,
            chainId,
            senderAddress,
            calls,
            privateKey: senderPrivateKey,
          });
        } else {
          const call = calls[0]!;
          fees = await estimateEoaTxFeePreview(
            rpcForHost,
            {
              to: call.to,
              from: senderAddress,
              data: call.data,
              value: call.value,
            },
            2_000_000n
          );
        }

        const transactions: TxPayloadJson[] = calls.map((call) => ({
          data: call.data,
          to: call.to,
          from: senderAddress,
          value: call.value.toString(),
        }));

        if (dryRun) {
          let needsDelegation: boolean | undefined;
          if (batchAsUserOp) {
            needsDelegation = await needsSimple7702Authorization(
              rpcForHost,
              senderAddress as `0x${string}`
            );
          }
          if (opts.nonInteractive) {
            logCliJson({
              fees,
              ...(batchAsUserOp
                ? {
                    mode: "eip7702-userop",
                    implementation: SIMPLE_7702_IMPLEMENTATION,
                    delegation: needsDelegation
                      ? "will-include-in-userop"
                      : "already-set",
                    calls: transactions,
                  }
                : { transactions }),
            });
          } else {
            if (txSpinner.active) txSpinner.stop();
            printShieldDryRunInteractive(
              calls,
              approvals.length,
              tokenMeta,
              senderAddress,
              batchAsUserOp
            );
            if (batchAsUserOp) {
              console.log(
                chalk.dim(
                  needsDelegation
                    ? "EIP-7702 delegation will be included in the UserOp."
                    : "Account already delegates to Simple7702; UserOp skips re-authorization."
                )
              );
              if (shieldTxs.length > 1) {
                console.log(
                  chalk.dim(
                    `Deposit plan: ${summarizeMultiShieldPlan(shieldTxs, tokenMeta)}`
                  )
                );
              }
            }
            printFeePreview(fees);
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

        if (batchAsUserOp) {
          const plan =
            shieldTxs.length > 1
              ? ` (${summarizeMultiShieldPlan(shieldTxs, tokenMeta)})`
              : "";
          await maybeConfirm(
            !!opts.nonInteractive,
            `Submit shield of ${amountPreview}${plan} as one EIP-7702 UserOp (${calls.length} calls) from ${senderAddress}?\n  ${feeConfirmLine(fees)}`,
            txSpinner
          );

          const sent = await runQuietSpinner(
            quiet,
            txSpinner,
            {
              start: `Submitting EIP-7702 shield UserOp (${calls.length} calls)...`,
              failure: "EIP-7702 shield UserOp failed.",
            },
            async () =>
              sendEip7702BatchUserOperation({
                client: rpcForHost,
                privateKey: senderPrivateKey,
                chainId,
                calls,
              }),
            (t) =>
              `UserOp mined: ${t.txHash}${
                t.delegatedInUserOp ? " (delegation included)" : ""
              }`
          );
          broadcastTransactions.push({
            type: "eip7702-userop",
            hash: sent.txHash,
            userOpHash: sent.userOpHash,
          });

          if (opts.nonInteractive) {
            logCliJson({
              mode: "eip7702-userop",
              implementation: sent.implementation,
              delegation: sent.delegatedInUserOp
                ? "included-in-userop"
                : "already-set",
              userOpHash: sent.userOpHash,
              txHash: sent.txHash,
              explorer: etherscanTxUrl(chainId, sent.txHash),
              calls: transactions,
              fees,
            });
            return;
          }
        } else {
          const call = calls[0]!;
          await maybeConfirm(
            !!opts.nonInteractive,
            shieldTransactionConfirmMessage({
              step: "1/1",
              txValue: call.value > 0n ? call.value : amount,
              shieldTxs,
              tokenMeta,
              senderAddress,
            }) + `\n  ${feeConfirmLine(fees)}`,
            txSpinner
          );

          const walletClient = makeWalletClient(
            senderPrivateKey,
            rpcForHost,
            rpcUrl
          );
          const sent = await runQuietSpinner(
            quiet,
            txSpinner,
            {
              start: "Sending shield tx...",
              failure: "Shield transaction failed.",
            },
            async () => {
              const hash = await sendTransactionAndWait(
                walletClient,
                rpcForHost,
                {
                  to: call.to,
                  data: call.data,
                  value: call.value,
                  gas: 2_000_000n,
                }
              );
              return { hash };
            },
            (s) => `Shield tx mined: ${s.hash}`
          );
          broadcastTransactions.push({ type: "shield", hash: sent.hash });

          if (opts.nonInteractive) {
            logCliJson({
              transactions: broadcastTransactions,
              fees,
            });
            return;
          }
        }
          }
        );
      } catch (e) {
        if (txSpinner.active) txSpinner.stop("Failed.", 1);
        cliErrorFromCaught(e);
        return;
      } finally {
        disposePublicClient(rpcForHost);
      }

      if (!opts.nonInteractive) {
        if (broadcastTransactions.length > 0) {
          console.log(chalk.bold("Etherscan links:"));
          for (const tx of broadcastTransactions) {
            if (tx.userOpHash) {
              console.log(chalk.dim(`  userOpHash: ${tx.userOpHash}`));
            }
            console.log(
              chalk.cyan(
                `  ${tx.type}: ${etherscanTxUrl(chainId, tx.hash)}`
              )
            );
          }
        }
        console.log(chalk.green("✔ Shield flow completed."));
      }
    });
}
