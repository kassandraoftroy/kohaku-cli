import { confirm, input, select } from "@inquirer/prompts";
import { log, spinner } from "@clack/prompts";
import chalk from "chalk";
import type { Command } from "commander";
import { formatUnits, getAddress, isAddress, parseUnits } from "viem";

import {
  formatAccountSelector,
  formatPublicAccountBalanceLabel,
  listPublicAccountsWithBalance,
  parseFromIndex,
  resolveShieldSender,
  simulateTransactionOrThrow,
  type PublicAccountWithBalance,
} from "../lib/shield-flow.js";
import {
  STEALTH_TEXT_RECORD_KEY,
  looksLikeStealthMetaAddress,
  resolveScheme1StealthMetaAddress,
} from "eth-stealth-address-resolver";
import { prepareStealthSend } from "../lib/stealth/send.js";
import { parseStealthIndex } from "../lib/stealth/storage.js";
import { cliOptions, passwordFileOption } from "../utils/cli-command-options";
import { logCliJson, quietNonInteractive, runQuietSpinner } from "../utils/cli-quiet";
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
import { jsonStringifyWithBigInt } from "../utils/json-bigint";
import { readSeedKeystore } from "../utils/mnemonic";
import {
  DEFAULT_DATA_DIR,
  getRpcChainIdMatchingWallet,
  makePublicClient,
  disposePublicClient,
  resolveRpcUrl,
} from "../utils/rpc";
import { runWithWalletTrafficLog, withTor } from "../utils/tor";
import { SIMPLE_7702_IMPLEMENTATION } from "../utils/simple-7702.js";
import { looksLikeName, resolveAddressOrName } from "../utils/resolve-name.js";
import { encodeContractCall, makeWalletClient, sendTransactionAndWait } from "../utils/viem-tx.js";
import { ERC20_ABI, resolveTokenMeta, type ResolvedTokenMeta } from "../utils/tokens-util";
import {
  estimateEthTransferGasReserveWei,
  transferMaxAmountFromBalance,
} from "../utils/transfer-max.js";
import {
  resolveWalletDir,
  resolveWalletNameOrPrompt,
  resolveWalletPassword,
} from "../utils/wallets-util";

type TransferOpts = {
  wallet?: string;
  password?: string;
  passwordFile?: string;
  from?: string;
  fromPriv?: boolean;
  to?: string;
  token?: string;
  amountWei?: string;
  amountFormatted?: string;
  amountMax?: boolean;
  rpcUrl?: string;
  nonInteractive?: boolean;
  broadcast?: boolean;
  stealth?: boolean;
  dataDir?: string;
  withoutTor?: boolean;
};

type TxPayloadJson = {
  data: string;
  to: string;
  from: string;
  value: string;
};

const ERC20_TRANSFER_ABI = ERC20_ABI;

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
  return {
    to: tokenMeta.tokenAddress,
    data: encodeContractCall(ERC20_ABI, "transfer", [recipient, amount]),
    value: 0n,
  };
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

async function computeTransferMaxAmount(opts: {
  rpcUrl: string;
  isEth: boolean;
  balance: bigint;
}): Promise<{ amount: bigint; ethGasReserveWei: bigint }> {
  if (!opts.isEth) {
    return {
      amount: transferMaxAmountFromBalance(opts.balance, { isEth: false }),
      ethGasReserveWei: 0n,
    };
  }
  const ethGasReserveWei = await estimateEthTransferGasReserveWei(opts.rpcUrl);
  return {
    amount: transferMaxAmountFromBalance(opts.balance, {
      isEth: true,
      ethGasReserveWei,
    }),
    ethGasReserveWei,
  };
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
    .addOption(passwordFileOption())
    .option("--from <address-or-index>", "Public sender address, HD index, or stealth selector (s0)")
    .option(
      "--from-priv",
      "With --broadcast: derive --from index from mnemonic when missing from public accounts"
    )
    .option("--to <address>", "Recipient address, name (.eth/.gwei/.wei), or stealth meta-address")
    .option(
      "--stealth",
      "Send via EIP-5564: resolve scheme-1 meta from --to (meta URI, name text record, or ERC-6538 registry)"
    )
    .option(
      "--broadcast",
      "Sign and submit on-chain (omit to simulate / print transaction payload only)"
    )
    .option("--token <address|symbol|eth>", "Token address or symbol (default: eth)")
    .option("--amount-wei <amount>", "Raw token amount in wei/base units")
    .option("--amount-formatted <amount>", "Decimal amount (converted using token decimals)")
    .option(
      "--amount-max",
      "Transfer the maximum spendable amount (ETH: balance minus estimated gas; ERC-20: full token balance)"
    )
    .option("--rpc-url <url>", cliOptions.rpcUrl)
    .option("--non-interactive", cliOptions.nonInteractiveShieldLike)
    .option("--without-tor", cliOptions.withoutTor)
    .option("--dataDir <path>", cliOptions.dataDir)
    .action(async (opts: TransferOpts) => {
      const amountFlags = [opts.amountWei, opts.amountFormatted, opts.amountMax].filter(
        Boolean
      ).length;
      if (amountFlags > 1) {
        cliError(
          "Provide only one of --amount-wei, --amount-formatted, or --amount-max."
        );
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

      let walletDir: string;
      try {
        walletDir = resolveWalletDir(dataDir, walletName);
      } catch (e) {
        cliErrorFromCaught(e);
        return;
      }

      const password = await resolveWalletPassword({
        flagPassword: opts.password,
        flagPasswordFile: opts.passwordFile,
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

      // Resolve names to addresses early so downstream index/address logic sees plain 0x… values.
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

      if (!fromValue && opts.nonInteractive) {
        cliError("Missing --from in non-interactive mode.");
        return;
      }
      if (!toValue && opts.nonInteractive) {
        cliError("Missing --to in non-interactive mode.");
        return;
      }
      if (
        amount === null &&
        !opts.amountMax &&
        opts.nonInteractive
      ) {
        cliError(
          "Missing amount in non-interactive mode. Provide --amount-wei, --amount-formatted, or --amount-max."
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

      const quiet = quietNonInteractive(opts.nonInteractive);

      try {
        if (withBalances.length === 0) {
          cliError(
            "No public or stealth accounts found in this wallet. Create one with next-fresh-address or init-profile first."
          );
          return;
        }

        const resolveMaxForFrom = async (from: string): Promise<bigint> => {
          const acct = findAccountWithBalance(from, withBalances);
          if (!acct) {
            throw new Error(
              `Could not find public account balance for --from ${from}.`
            );
          }
          const { amount: maxAmount, ethGasReserveWei } =
            await computeTransferMaxAmount({
              rpcUrl,
              isEth: tokenMeta.isEth,
              balance: acct.balance,
            });
          if (maxAmount <= 0n) {
            throw new Error(
              tokenMeta.isEth
                ? `Insufficient ETH for --amount-max after reserving ~${formatUnits(ethGasReserveWei, 18)} ETH for gas.`
                : `No spendable ${tokenMeta.symbol} balance for --amount-max.`
            );
          }
          if (!quiet && tokenMeta.isEth && ethGasReserveWei > 0n) {
            log.info(
              `Reserving ~${formatUnits(ethGasReserveWei, 18)} ETH for estimated transfer gas.`
            );
          }
          return maxAmount;
        };

        if (opts.amountMax) {
          if (!fromValue) {
            console.log();
            console.log(
              chalk.bold(`Available accounts (${tokenMeta.symbol} balances):`)
            );
            for (const acct of withBalances) {
              console.log(
                `  [${acct.index}] ${acct.address}  ${formatPublicAccountBalanceLabel(acct, tokenMeta)}`
              );
            }
            fromValue = await promptSourceAccount(
              withBalances,
              tokenMeta,
              `Pick source account for max ${tokenMeta.symbol} transfer`
            );
          }
          amount = await resolveMaxForFrom(fromValue);
        } else if (amount === null) {
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
            message: `Amount to transfer (${tokenMeta.symbol}, formatted, or "max"):`,
            validate: (value) => {
              const trimmed = value.trim();
              if (!trimmed) return "Amount is required.";
              if (trimmed.toLowerCase() === "max") return true;
              try {
                const parsed = parseUnits(trimmed, tokenMeta.decimals);
                if (parsed <= 0n) return "Amount must be greater than zero.";
              } catch {
                return `Invalid ${tokenMeta.symbol} amount format.`;
              }
              return true;
            },
          });
          if (amountFormattedInput.trim().toLowerCase() === "max") {
            if (!fromValue) {
              fromValue = await promptSourceAccount(
                withBalances,
                tokenMeta,
                `Pick source account for max ${tokenMeta.symbol} transfer`
              );
            }
            amount = await resolveMaxForFrom(fromValue);
          } else {
            amount = parseUnits(
              amountFormattedInput.trim(),
              tokenMeta.decimals
            );
          }
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
            message: "Recipient address, name (.eth/.gwei/.wei), or stealth meta (st:…):",
            validate: (value) => {
              const v = value.trim();
              if (!v) return "Recipient is required.";
              if (
                !isAddress(v) &&
                !looksLikeName(v) &&
                !looksLikeStealthMetaAddress(v)
              ) {
                return "Enter an address, a .eth/.gwei/.wei name, or a stealth meta-address.";
              }
              return true;
            },
          });
          toValue = toValue.trim();
        }
      } catch (e) {
        cliErrorFromCaught(e);
        return;
      }

      let stealthMetaURI: string | null = null;
      try {
        if (opts.stealth) {
          const resolved = await resolveScheme1StealthMetaAddress({
            input: toValue,
            rpcUrl,
            chainId,
          });
          stealthMetaURI = resolved.uri;
          if (!opts.nonInteractive) {
            const via =
              resolved.source === "meta"
                ? "raw meta-address"
                : resolved.source === "text"
                  ? `${STEALTH_TEXT_RECORD_KEY} on ${resolved.name}`
                  : `ERC-6538 registry${resolved.registrant ? ` (${resolved.registrant})` : ""}`;
            console.log(chalk.dim(`Resolved scheme-1 stealth meta via ${via}.`));
          }
        } else if (looksLikeStealthMetaAddress(toValue)) {
          throw new Error(
            "Recipient looks like a stealth meta-address. Pass --stealth to send an EIP-5564 stealth transfer."
          );
        }
      } catch (e) {
        cliErrorFromCaught(e);
        return;
      }

      let recipient: string;
      try {
        if (stealthMetaURI) {
          recipient = stealthMetaURI; // placeholder until plan builds ephemeral address
        } else {
          recipient = await resolveAddressOrName(toValue, rpcUrl);
        }
      } catch (e) {
        cliErrorFromCaught(e);
        return;
      }

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

      if (
        !stealthMetaURI &&
        recipient.toLowerCase() === senderAddress.toLowerCase()
      ) {
        cliError("Sender and recipient must be different addresses.");
        return;
      }

      const stealthPlan = stealthMetaURI
        ? prepareStealthSend({
            stealthMetaAddressURI: stealthMetaURI,
            chainId,
            token: {
              isEth: tokenMeta.isEth,
              tokenAddress: tokenMeta.tokenAddress,
            },
            amount,
          })
        : null;
      const recipientAddress = stealthPlan
        ? stealthPlan.stealthAddress
        : recipient;
      const txs = stealthPlan
        ? [stealthPlan.transferTx, stealthPlan.announceTx]
        : [buildTransferTx(tokenMeta, recipientAddress, amount)];

      await withTor(!opts.withoutTor, { rpcUrl, walletDir }, async () => {
      const client = await makePublicClient(rpcUrl);
      const txSpinner = spinner();
      const amountPreview = `${formatUnits(amount, tokenMeta.decimals)} ${tokenMeta.symbol}`;

      try {
        const batchAsUserOp = !!stealthPlan;
        const payloads: TxPayloadJson[] = txs.map((tx) => ({
          data: tx.data,
          to: tx.to,
          from: senderAddress,
          value: tx.value.toString(),
        }));

        // Stealth = transfer + announce: batch via EIP-7702 UserOp (same as shield).
        // Do not eth_call each payload alone — bundler prepare validates the batch.
        if (!batchAsUserOp) {
          await simulateTransactionOrThrow(
            client,
            {
              to: txs[0]!.to,
              from: senderAddress,
              data: txs[0]!.data,
              value: txs[0]!.value,
            },
            "Transfer transaction"
          );
        }

        const eip7702Tor = {
          rpcUrl,
          walletDir,
          withoutTor: !!opts.withoutTor,
        };

        // Dry-run: estimate once. Broadcast UserOp: one Tor session for estimate+send.
        if (batchAsUserOp && dryRun) {
          const fees = await estimateEip7702BatchUserOpFee({
            client,
            chainId,
            senderAddress,
            calls: txs,
            privateKey: senderPrivateKey,
            ...eip7702Tor,
          });
          const needsDelegation = await needsSimple7702Authorization(
            client,
            senderAddress as `0x${string}`
          );

          if (opts.nonInteractive) {
            logCliJson({
              stealth: !!stealthPlan,
              stealthMetaAddressURI: stealthMetaURI ?? undefined,
              recipient: recipientAddress,
              ephemeralPublicKey: stealthPlan?.ephemeralPublicKey,
              amount: amount.toString(),
              token: tokenMeta.isEth ? "eth" : tokenMeta.tokenAddress,
              fees,
              mode: "eip7702-userop",
              implementation: SIMPLE_7702_IMPLEMENTATION,
              delegation: needsDelegation
                ? "will-include-in-userop"
                : "already-set",
              calls: payloads,
            });
          } else {
            console.log();
            console.log(
              chalk.bold("Planned EIP-7702 UserOperation (not submitted)")
            );
            console.log(
              chalk.dim(
                "Add --broadcast to submit transfer + announce as one Pimlico UserOp (EIP-7702 Simple7702Account)."
              )
            );
            console.log();
            console.log(
              chalk.dim(
                `Stealth transfer ${amountPreview} from ${senderAddress} → ${recipientAddress}`
              )
            );
            console.log(chalk.dim(`Implementation: ${SIMPLE_7702_IMPLEMENTATION}`));
            console.log(chalk.cyan("Transfer call:"), jsonStringifyWithBigInt(payloads[0]!));
            console.log(chalk.cyan("Announce call:"), jsonStringifyWithBigInt(payloads[1]!));
            console.log(
              chalk.dim(
                needsDelegation
                  ? "EIP-7702 delegation will be included in the UserOp."
                  : "Account already delegates to Simple7702; UserOp skips re-authorization."
              )
            );
            printFeePreview(fees);
            console.log(chalk.green("✔ Transfer dry run complete."));
          }
          return;
        }

        if (!batchAsUserOp) {
          const fees = await estimateEoaTxFeePreview(
            client,
            {
              to: txs[0]!.to,
              from: senderAddress,
              data: txs[0]!.data,
              value: txs[0]!.value,
            },
            tokenMeta.isEth ? 21_000n : 65_000n
          );

          if (dryRun) {
            if (opts.nonInteractive) {
              logCliJson({
                stealth: false,
                stealthMetaAddressURI: stealthMetaURI ?? undefined,
                recipient: recipientAddress,
                amount: amount.toString(),
                token: tokenMeta.isEth ? "eth" : tokenMeta.tokenAddress,
                fees,
                transactions: payloads,
              });
            } else {
              printTransferDryRunInteractive(
                txs[0]!,
                tokenMeta,
                senderAddress,
                recipientAddress,
                amount,
                tokenMeta.decimals
              );
              printFeePreview(fees);
              console.log(chalk.green("✔ Transfer dry run complete."));
            }
            return;
          }

          if (!senderPrivateKey) {
            cliError(
              "Cannot sign: no private key for this --from (use a saved public/stealth account or --from-priv with --broadcast)."
            );
            return;
          }

          await maybeConfirm(
            !!opts.nonInteractive,
            `Send transfer: ${amountPreview} from ${senderAddress} to ${recipientAddress}?\n  ${feeConfirmLine(fees)}`
          );

          const walletClient = makeWalletClient(senderPrivateKey, client, rpcUrl);
          const hash = await runQuietSpinner(
            quiet,
            txSpinner,
            { start: "Sending transfer...", failure: "Transfer failed." },
            async () =>
              sendTransactionAndWait(walletClient, client, {
                to: txs[0]!.to,
                data: txs[0]!.data,
                value: txs[0]!.value,
              }),
            (h) => `Mined: ${h}`
          );

          if (opts.nonInteractive) {
            logCliJson({
              stealth: false,
              hashes: [hash],
              explorers: [etherscanTxUrl(chainId, hash)],
              from: senderAddress,
              to: recipientAddress,
              amount: amount.toString(),
              token: tokenMeta.isEth ? "eth" : tokenMeta.tokenAddress,
            });
          } else {
            console.log();
            console.log(chalk.green("✔ Transfer complete."));
            console.log(chalk.dim(etherscanTxUrl(chainId, hash)));
          }
          return;
        }

        if (!senderPrivateKey) {
          cliError(
            "Cannot sign: no private key for this --from (use a saved public/stealth account or --from-priv with --broadcast)."
          );
          return;
        }

        let fees: FeePreview;
        const sent = await withTor(
          !opts.withoutTor,
          { rpcUrl, walletDir },
          async () => {
            fees = await estimateEip7702BatchUserOpFee({
              client,
              chainId,
              senderAddress,
              calls: txs,
              privateKey: senderPrivateKey,
              ...eip7702Tor,
            });
            await maybeConfirm(
              !!opts.nonInteractive,
              `Submit stealth transfer of ${amountPreview} as one EIP-7702 UserOp (transfer + announce) from ${senderAddress}?\n  ${feeConfirmLine(fees)}`
            );

            return runQuietSpinner(
              quiet,
              txSpinner,
              {
                start:
                  "Submitting EIP-7702 stealth UserOp (transfer + announce)...",
                failure: "EIP-7702 stealth UserOp failed.",
              },
              async () =>
                sendEip7702BatchUserOperation({
                  client,
                  privateKey: senderPrivateKey,
                  chainId,
                  calls: txs,
                  ...eip7702Tor,
                }),
              (t) =>
                `UserOp mined: ${t.txHash}${
                  t.delegatedInUserOp ? " (delegation included)" : ""
                }`
            );
          }
        );

        if (opts.nonInteractive) {
          logCliJson({
            stealth: true,
            mode: "eip7702-userop",
            implementation: sent.implementation,
            delegation: sent.delegatedInUserOp
              ? "included-in-userop"
              : "already-set",
            userOpHash: sent.userOpHash,
            txHash: sent.txHash,
            explorer: etherscanTxUrl(chainId, sent.txHash),
            from: senderAddress,
            to: recipientAddress,
            stealthMetaAddressURI: stealthMetaURI ?? undefined,
            ephemeralPublicKey: stealthPlan.ephemeralPublicKey,
            amount: amount.toString(),
            token: tokenMeta.isEth ? "eth" : tokenMeta.tokenAddress,
            calls: payloads,
            fees: fees!,
          });
        } else {
          console.log();
          console.log(chalk.green("✔ Stealth transfer complete (batched UserOp)."));
          console.log(chalk.dim(etherscanTxUrl(chainId, sent.txHash)));
        }
      } catch (e) {
        cliErrorFromCaught(e);
      } finally {
        disposePublicClient(client);
      }
      });
    });
}
