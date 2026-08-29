import { confirm, input, select } from "@inquirer/prompts";
import { log, spinner } from "@clack/prompts";
import chalk from "chalk";
import type { AssetAmount } from "@kohaku-eth/plugins";
import type { Command } from "commander";
import { formatUnits, getAddress, isAddress, parseUnits } from "viem";
import { Mnemonic } from "derive-railgun-keys";

import { makeHost } from "../host/makeHost";
import {
  buildShieldCallList,
  formatAccountSelector,
  formatPublicAccountBalanceLabel,
  listPublicAccountsWithBalance,
  partitionShieldTxs,
  resolveShieldApprovalCalls,
  shieldTransactionConfirmMessage,
  summarizeMultiShieldPlan,
  toShieldTxs,
  type PublicAccountWithBalance,
} from "../lib/shield-flow.js";
import { parseStealthIndex } from "../lib/stealth/storage.js";
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
  buildFeePreview,
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
import { isFirstProtocolSync } from "../utils/first-sync.js";
import { resolveTokenMeta } from "../utils/tokens-util";
import type { ResolvedTokenMeta } from "../utils/tokens-util";
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
  computeShieldMaxAmount,
  estimateShieldGasReserveWei,
  eoaShieldSendParams,
  refineShieldMaxAmount,
  SHIELD_GAS_LIMIT,
  shieldMaxFeeReserveWei,
} from "../utils/shield-max.js";
import {
  assertTornadoDepositAmount,
  assertTornadoTokenSupported,
  tornadoMinDenomination,
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
  amountMax?: boolean;
  rpcUrl?: string;
  baseFeeGwei?: string;
  priorityFeeGwei?: string;
  nonInteractive?: boolean;
  broadcast?: boolean;
  skipSim?: boolean;
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

function findAccountWithBalance(
  fromValue: string,
  accounts: PublicAccountWithBalance[]
): PublicAccountWithBalance | undefined {
  const stealthIdx = parseStealthIndex(fromValue);
  if (stealthIdx !== null) {
    return accounts.find(
      (a) => a.kind === "stealth" && a.stealthIndex === stealthIdx
    );
  }
  const idx = parseFromIndex(fromValue);
  if (idx !== null) {
    return accounts.find((a) => a.kind !== "stealth" && a.index === idx);
  }
  if (isAddress(fromValue)) {
    const addr = getAddress(fromValue).toLowerCase();
    return accounts.find((a) => a.address.toLowerCase() === addr);
  }
  return undefined;
}

async function promptSourceAccount(
  withBalances: PublicAccountWithBalance[],
  tokenMeta: ResolvedTokenMeta,
  message: string
): Promise<string> {
  const candidates = withBalances.filter((x) => x.balance > 0n);
  if (candidates.length === 0) {
    throw new Error(
      `No public account has a positive ${tokenMeta.symbol} balance.`
    );
  }
  return select<string>({
    message,
    choices: candidates.map((acct) => ({
      value: acct.address,
      name: `[${formatAccountSelector(acct)}] ${acct.address}  (${formatPublicAccountBalanceLabel(acct, tokenMeta)})`,
    })),
  });
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
    .option(
      "--skip-sim",
      "Skip on-chain simulation and fee estimates (dry-run only; not allowed with --broadcast)"
    )
    .option("--token <address|symbol|eth>", "Token address or symbol (default: eth)")
    .option("--amount-wei <amount>", "Raw token amount in wei/base units")
    .option("--amount-formatted <amount>", "Decimal amount (converted using token decimals)")
    .option(
      "--amount-max",
      "Shield the maximum spendable amount (ETH: balance minus estimated gas; ERC-20: full token balance; Tornado: floored to the smallest pool denomination)"
    )
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

      const amountFlags = [
        opts.amountWei,
        opts.amountFormatted,
        opts.amountMax,
      ].filter(Boolean).length;
      if (amountFlags > 1) {
        cliError(
          "Provide only one of --amount-wei, --amount-formatted, or --amount-max."
        );
        return;
      }
      if (opts.skipSim && opts.broadcast) {
        cliError("--skip-sim cannot be used with --broadcast.");
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
      if (amount === null && !opts.amountMax && opts.nonInteractive) {
        cliError(
          "Missing amount in non-interactive mode. Provide --amount-wei, --amount-formatted, or --amount-max."
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

      let usedAmountMax = !!opts.amountMax;
      let amountMaxEthBalance: bigint | undefined;
      let amountMaxMinDenom: bigint | undefined;

      try {
        if (
          fromValue &&
          parseFromIndex(fromValue) === null &&
          parseStealthIndex(fromValue) === null &&
          !isAddress(fromValue)
        ) {
          fromValue = await resolveAddressOrName(fromValue, rpcUrl);
        }

        const resolveMaxForFrom = async (from: string): Promise<bigint> => {
          const acct = findAccountWithBalance(from, withBalances);
          if (!acct) {
            throw new Error(
              `Could not find public account balance for --from ${from}.`
            );
          }
          const gasReserveWei = await estimateShieldGasReserveWei(rpcUrl);
          const minDenom =
            protocol === "tornado"
              ? tornadoMinDenomination(chainId, {
                  isEth: tokenMeta.isEth,
                  tokenAddress: tokenMeta.tokenAddress,
                  symbol: tokenMeta.symbol,
                })
              : undefined;
          const { amount: maxAmount } = computeShieldMaxAmount({
            isEth: tokenMeta.isEth,
            protocol,
            tokenBalance: acct.balance,
            ethBalance: acct.ethBalance,
            gasReserveWei,
            minDenom,
          });
          if (maxAmount <= 0n) {
            throw new Error(
              tokenMeta.isEth
                ? `Insufficient ETH for --amount-max after reserving ~${formatUnits(gasReserveWei, 18)} ETH for gas.`
                : acct.ethBalance < gasReserveWei
                  ? `Insufficient ETH to cover estimated shield gas (~${formatUnits(gasReserveWei, 18)} ETH) for --amount-max.`
                  : `No spendable ${tokenMeta.symbol} balance for --amount-max.`
            );
          }
          usedAmountMax = true;
          amountMaxEthBalance = acct.ethBalance;
          amountMaxMinDenom = minDenom;
          fromValue = acct.address;
          if (!quietNonInteractive(opts.nonInteractive) && gasReserveWei > 0n) {
            log.info(
              `Reserving ~${formatUnits(gasReserveWei, 18)} ETH for estimated shield gas.`
            );
          }
          return maxAmount;
        };

        if (usedAmountMax) {
          if (withBalances.length === 0) {
            cliError(
              "No public accounts found in this wallet. Create one with nextFreshAddress first."
            );
            return;
          }
          if (!fromValue) {
            console.log();
            console.log(
              chalk.bold(`Available accounts (${tokenMeta.symbol} balances):`)
            );
            for (const acct of withBalances) {
              console.log(
                `  [${formatAccountSelector(acct)}] ${acct.address}  ${formatPublicAccountBalanceLabel(acct, tokenMeta)}`
              );
            }
            fromValue = await promptSourceAccount(
              withBalances,
              tokenMeta,
              `Pick source account for max ${tokenMeta.symbol} shield`
            );
          }
          amount = await resolveMaxForFrom(fromValue);
        } else if (amount === null) {
          if (opts.nonInteractive) {
            cliError(
              "Missing amount in non-interactive mode. Provide --amount-wei, --amount-formatted, or --amount-max."
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
              `  [${formatAccountSelector(acct)}] ${acct.address}  ${formatPublicAccountBalanceLabel(acct, tokenMeta)}`
            );
          }

          const amountFormattedInput = await input({
            message: `Amount to shield (${tokenMeta.symbol}, formatted, or "max"):`,
            validate: (value) => {
              const trimmed = value.trim();
              if (!trimmed) return "Amount is required.";
              if (trimmed.toLowerCase() === "max") return true;
              try {
                const parsed = parseUnits(trimmed, tokenMeta.decimals);
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
          if (amountFormattedInput.trim().toLowerCase() === "max") {
            if (!fromValue) {
              fromValue = await promptSourceAccount(
                withBalances,
                tokenMeta,
                `Pick source account for max ${tokenMeta.symbol} shield`
              );
            }
            amount = await resolveMaxForFrom(fromValue);
          } else {
            amount = parseUnits(
              amountFormattedInput.trim(),
              tokenMeta.decimals
            );
            if (protocol === "tornado") {
              assertTornadoDepositAmount(chainId, amount, {
                isEth: tokenMeta.isEth,
                tokenAddress: tokenMeta.tokenAddress,
                symbol: tokenMeta.symbol,
                decimals: tokenMeta.decimals,
              });
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
              name: `[${formatAccountSelector(acct)}] ${acct.address}  (${formatPublicAccountBalanceLabel(acct, tokenMeta)}, need ${formatUnits(amount!, tokenMeta.decimals)} ${tokenMeta.symbol})`,
            })),
          });
          fromValue = chosen;
        }
      } catch (e) {
        cliErrorFromCaught(e);
        return;
      }

      if (amount === null) {
        cliError("Amount is required.");
        return;
      }

      // Resolve ENS / GNS / WNS names to addresses before the index/address branch.
      if (
        fromValue &&
        parseFromIndex(fromValue) === null &&
        parseStealthIndex(fromValue) === null &&
        !isAddress(fromValue)
      ) {
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
      const eip7702Tor = {
        rpcUrl,
        walletDir,
        withoutTor: !!opts.withoutTor,
      };
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

        const assetFor = (amt: bigint): AssetAmount =>
          (protocol === "railgun"
            ? tokenMeta.isEth
              ? {
                  asset: { __type: "native" as const },
                  amount: amt,
                }
              : railgunErc20AssetAmount(tokenMeta.tokenAddress, amt)
            : {
                asset: {
                  __type: "erc20",
                  contract: (tokenMeta.isEth
                    ? ETH_AS_ERC20
                    : tokenMeta.tokenAddress) as `0x${string}`,
                },
                amount: amt,
              }) as AssetAmount;

        const prepareShieldCalls = async (amt: bigint) => {
          const op = await prepareProtocolShield(
            plugin,
            protocol,
            assetFor(amt)
          );
          const rawTxs = toShieldTxs(op);
          let nextApprovals: Array<{ to: string; data: string; value: bigint }> =
            [];
          let nextDeposits: Array<{ to: string; data: string; value: bigint }>;
          if (tokenMeta.isEth) {
            nextDeposits = partitionShieldTxs(rawTxs).deposits;
          } else {
            const resolved = await resolveShieldApprovalCalls({
              client: rpcForHost,
              tokenAddress: tokenMeta.tokenAddress,
              senderAddress,
              amount: amt,
              shieldTxs: rawTxs,
            });
            nextApprovals = resolved.approvals;
            nextDeposits = resolved.deposits;
          }
          return {
            approvals: nextApprovals,
            shieldTxs: nextDeposits,
            calls: buildShieldCallList(nextApprovals, nextDeposits),
          };
        };

        let shieldTxs: Array<{ to: string; data: string; value: bigint }>;
        let approvals: Array<{ to: string; data: string; value: bigint }> = [];
        let calls: ReturnType<typeof buildShieldCallList>;
        try {
          if (!quiet) txSpinner.start("Syncing private state...");
          const prepared = await runWithSyncProgress(
            {
              source: protocol,
              firstRun: isFirstProtocolSync(walletDir, protocol),
              onUpdate: quiet ? undefined : (message) => txSpinner.start(message),
            },
            async () => {
              await syncPluginWithProgress(plugin, protocol);
              return prepareShieldCalls(amount!);
            }
          );
          if (txSpinner.active) txSpinner.stop("Private state synced.");
          approvals = prepared.approvals;
          shieldTxs = prepared.shieldTxs;
          calls = prepared.calls;

          if (usedAmountMax && amountMaxEthBalance !== undefined) {
            for (let i = 0; i < 3; i++) {
              const batch = calls.length > 1;
              const feePreview = batch
                ? await estimateEip7702BatchUserOpFee({
                    client: rpcForHost,
                    chainId,
                    senderAddress,
                    calls,
                    ...eip7702Tor,
                  })
                : await estimateEoaTxFeePreview(
                    rpcForHost,
                    {
                      to: calls[0]!.to,
                      from: senderAddress,
                      data: calls[0]!.data,
                      value: calls[0]!.value,
                    },
                    SHIELD_GAS_LIMIT
                  );
              const estimatedFeeWei = shieldMaxFeeReserveWei({
                batch,
                estimatedMaxWei: BigInt(feePreview.estimatedMax),
                maxFeePerGasWei: feePreview.maxFeePerGasWei
                  ? BigInt(feePreview.maxFeePerGasWei)
                  : undefined,
                gasLimit: feePreview.gasLimit
                  ? BigInt(feePreview.gasLimit)
                  : undefined,
              });
              const refined = refineShieldMaxAmount({
                isEth: tokenMeta.isEth,
                protocol,
                currentAmount: amount!,
                ethBalance: amountMaxEthBalance,
                estimatedFeeWei,
                minDenom: amountMaxMinDenom,
              });
              if (refined === 0n) {
                throw new Error(
                  tokenMeta.isEth
                    ? `Insufficient ETH for --amount-max after reserving ~${formatUnits(estimatedFeeWei, 18)} ETH for gas.`
                    : `Insufficient ETH to cover estimated shield gas (~${formatUnits(estimatedFeeWei, 18)} ETH) for --amount-max.`
                );
              }
              if (refined >= amount!) break;
              if (!quiet) {
                log.info(
                  `Refining --amount-max: ${formatUnits(amount!, tokenMeta.decimals)} → ${formatUnits(refined, tokenMeta.decimals)} ${tokenMeta.symbol}`
                );
              }
              amount = refined;
              const next = await prepareShieldCalls(amount);
              approvals = next.approvals;
              shieldTxs = next.shieldTxs;
              calls = next.calls;
            }
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : JSON.stringify(e);
          cliError(msg);
          return;
        }

        const batchAsUserOp = calls.length > 1;
        const amountPreview = `${formatUnits(amount!, tokenMeta.decimals)} ${tokenMeta.symbol}`;

        let fees: FeePreview;
        if (opts.skipSim) {
          fees = buildFeePreview({
            kind: batchAsUserOp ? "eip7702-userop" : "network-gas",
            amount: 0n,
            decimals: 18,
            asset: "ETH",
          });
        } else {
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

          if (batchAsUserOp) {
            fees = await estimateEip7702BatchUserOpFee({
              client: rpcForHost,
              chainId,
              senderAddress,
              calls,
              privateKey: senderPrivateKey,
              ...eip7702Tor,
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
              SHIELD_GAS_LIMIT
            );
          }
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
            if (opts.skipSim) {
              console.log(
                chalk.dim(
                  "Simulation skipped (--skip-sim); payloads are not validated on-chain."
                )
              );
            }
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
                ...eip7702Tor,
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
              txValue: call.value > 0n ? call.value : amount!,
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
              const preview = await estimateEoaTxFeePreview(
                rpcForHost,
                {
                  to: call.to,
                  from: senderAddress,
                  data: call.data,
                  value: call.value,
                },
                SHIELD_GAS_LIMIT
              );
              const params = eoaShieldSendParams({
                estimatedGas: BigInt(preview.gasLimit ?? SHIELD_GAS_LIMIT),
                maxFeePerGas: BigInt(preview.maxFeePerGasWei ?? 0n),
                maxPriorityFeePerGas: BigInt(
                  preview.maxPriorityFeePerGasWei ?? 0n
                ),
                value: call.value,
                balance:
                  usedAmountMax && amountMaxEthBalance !== undefined
                    ? amountMaxEthBalance
                    : undefined,
              });
              if (params.maxFeePerGas === 0n) {
                throw new Error(
                  "Could not determine gas price for shield broadcast."
                );
              }
              if (
                usedAmountMax &&
                amountMaxEthBalance !== undefined &&
                params.gas * params.maxFeePerGas + call.value >
                  amountMaxEthBalance
              ) {
                throw new Error(
                  `Insufficient ETH for --amount-max after reserving ~${formatUnits(params.gas * params.maxFeePerGas, 18)} ETH for gas.`
                );
              }
              const hash = await sendTransactionAndWait(
                walletClient,
                rpcForHost,
                {
                  to: call.to,
                  data: call.data,
                  value: call.value,
                  gas: params.gas,
                  maxFeePerGas: params.maxFeePerGas,
                  maxPriorityFeePerGas: params.maxPriorityFeePerGas,
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
