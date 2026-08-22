import { confirm, select } from "@inquirer/prompts";
import { spinner } from "@clack/prompts";
import chalk from "chalk";
import type { Command } from "commander";
import { getAddress, isAddress } from "viem";

import {
  formatPublicAccountBalanceLabel,
  listPublicAccountsWithBalance,
  parseFromIndex,
  resolveShieldSender,
  simulateTransactionOrThrow,
} from "../lib/shield-flow.js";
import { cliOptions } from "../utils/cli-command-options";
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
  sumEoaFeePreviews,
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
import { SIMPLE_7702_IMPLEMENTATION } from "../utils/simple-7702.js";
import { withTor } from "../utils/tor";
import { resolveAddressOrName } from "../utils/resolve-name.js";
import { makeWalletClient, sendTransactionAndWait } from "../utils/viem-tx.js";
import { resolveTokenMeta } from "../utils/tokens-util";
import {
  resolveWalletDir,
  resolveWalletNameOrPrompt,
  resolveWalletPassword,
} from "../utils/wallets-util";

type TransactRawOpts = {
  wallet?: string;
  password?: string;
  from?: string;
  fromPriv?: boolean;
  targets?: string;
  payloads?: string;
  values?: string;
  rpcUrl?: string;
  nonInteractive?: boolean;
  broadcast?: boolean;
  dataDir?: string;
  withoutTor?: boolean;
};

type RawTx = {
  to: string;
  data: string;
  value: bigint;
};

type TxPayloadJson = {
  data: string;
  to: string;
  from: string;
  value: string;
};

function etherscanTxUrl(chainId: bigint, txHash: string): string {
  const host = chainId === 11155111n ? "sepolia.etherscan.io" : "etherscan.io";
  return `https://${host}/tx/${txHash}`;
}

function parseCommaSeparatedList(raw: string, label: string): string[] {
  const parts = raw
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length === 0) {
    throw new Error(`${label} must contain at least one entry.`);
  }
  return parts;
}

function parseTargets(raw: string): string[] {
  const parts = parseCommaSeparatedList(raw, "--targets");
  return parts.map((part, i) => {
    if (!isAddress(part)) {
      throw new Error(`Invalid target address at index ${i}: ${part}`);
    }
    return getAddress(part);
  });
}

function parsePayloads(raw: string): string[] {
  const parts = parseCommaSeparatedList(raw, "--payloads");
  return parts.map((part, i) => {
    if (!part.startsWith("0x")) {
      throw new Error(`Invalid payload at index ${i}: must start with 0x`);
    }
    if (!/^0x[0-9a-fA-F]*$/.test(part)) {
      throw new Error(`Invalid payload hex at index ${i}: ${part}`);
    }
    return part;
  });
}

function parseValues(raw: string | undefined, count: number): bigint[] {
  if (!raw) {
    return Array.from({ length: count }, () => 0n);
  }
  const parts = parseCommaSeparatedList(raw, "--values");
  if (parts.length !== count) {
    throw new Error(
      `--values count (${parts.length}) must match --targets count (${count}).`
    );
  }
  return parts.map((part, i) => {
    try {
      const value = BigInt(part);
      if (value < 0n) {
        throw new Error("negative");
      }
      return value;
    } catch {
      throw new Error(`Invalid --values entry at index ${i}: ${part}`);
    }
  });
}

function buildRawTransactions(
  targets: string[],
  payloads: string[],
  values: bigint[]
): RawTx[] {
  return targets.map((to, i) => ({
    to,
    data: payloads[i]!,
    value: values[i]!,
  }));
}

async function maybeConfirm(nonInteractive: boolean, message: string): Promise<void> {
  if (nonInteractive) return;
  const ok = await confirm({ message, default: false });
  if (!ok) {
    throw new Error("Cancelled by user.");
  }
}

function printDryRunInteractive(
  transactions: TxPayloadJson[],
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
        `Calls: ${transactions.length} (batched via executeBatch in one UserOp)`
      )
    );
  }
  for (let i = 0; i < transactions.length; i++) {
    console.log(
      chalk.cyan(
        batchAsUserOp
          ? `Call ${i + 1}/${transactions.length}:`
          : `Transaction ${i + 1}/${transactions.length}:`
      ),
      jsonStringifyWithBigInt(transactions[i])
    );
  }
}

export function registerTransactRawCommand(program: Command): void {
  program
    .command("transact-raw")
    .description(
      "Send one or more raw contract calls from a public account (2+ calls → one EIP-7702 UserOp via Pimlico)"
    )
    .requiredOption(
      "--targets <addresses>",
      "Comma-separated contract addresses to call (same order as --payloads)"
    )
    .requiredOption(
      "--payloads <hex>",
      "Comma-separated calldata hex strings (same order as --targets). Two or more are batched into a single EIP-7702 UserOperation."
    )
    .option("--wallet <name>", cliOptions.walletPickList)
    .option("--password <password>", cliOptions.password)
    .option("--from <address-or-index>", "Public sender address or public-account index")
    .option(
      "--from-priv",
      "With --broadcast: derive --from index from mnemonic when missing from public accounts"
    )
    .option(
      "--values <wei>",
      "Comma-separated ETH values in wei per call (default: 0 for each)"
    )
    .option(
      "--broadcast",
      "Sign and submit on-chain (one EOA tx, or one EIP-7702 UserOp when 2+ calls)"
    )
    .option("--rpc-url <url>", cliOptions.rpcUrl)
    .option("--non-interactive", cliOptions.nonInteractiveShieldLike)
    .option("--without-tor", cliOptions.withoutTor)
    .option("--dataDir <path>", cliOptions.dataDir)
    .action(async (opts: TransactRawOpts) => {
      const rpcUrl = resolveRpcUrl(opts.rpcUrl);

      let targets: string[];
      let payloads: string[];
      let values: bigint[];
      try {
        targets = parseTargets(opts.targets ?? "");
        payloads = parsePayloads(opts.payloads ?? "");
        if (targets.length !== payloads.length) {
          cliError(
            `--targets count (${targets.length}) must match --payloads count (${payloads.length}).`
          );
          return;
        }
        values = parseValues(opts.values, targets.length);
      } catch (e) {
        cliErrorFromCaught(e);
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

      const broadcast = !!opts.broadcast;
      const dryRun = !broadcast;
      let fromValue = opts.from ?? "";

      if (fromValue && parseFromIndex(fromValue) === null && !isAddress(fromValue)) {
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

      if (!fromValue) {
        let ethMeta: Awaited<ReturnType<typeof resolveTokenMeta>>;
        try {
          ethMeta = await resolveTokenMeta("eth", rpcUrl, chainId);
        } catch (e) {
          cliErrorFromCaught(e);
          return;
        }

        const accounts = await listPublicAccountsWithBalance(
          rpcUrl,
          walletDir,
          mnemonic,
          password,
          ethMeta
        );
        if (accounts.length === 0) {
          cliError(
            "No public accounts found in this wallet. Create one with next-fresh-address first."
          );
          return;
        }

        try {
          console.log();
          console.log(chalk.bold("Available accounts (ETH balances):"));
          for (const acct of accounts) {
            console.log(
              `  [${acct.index}] ${acct.address}  ${formatPublicAccountBalanceLabel(acct, ethMeta)}`
            );
          }

          const chosen = await select<string>({
            message: "Pick source account",
            choices: accounts.map((acct) => ({
              value: acct.address,
              name: `[${acct.index}] ${acct.address}  (${formatPublicAccountBalanceLabel(acct, ethMeta)})`,
            })),
          });
          fromValue = chosen;
        } catch (e) {
          cliErrorFromCaught(e);
          return;
        }
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

      const rawTxs = buildRawTransactions(targets, payloads, values);
      await withTor(!opts.withoutTor, { rpcUrl, walletDir }, async () => {
      const client = await makePublicClient(rpcUrl);
      const txSpinner = spinner();
      const quiet = quietNonInteractive(opts.nonInteractive);

      try {
        const transactions: TxPayloadJson[] = rawTxs.map((tx) => ({
          data: tx.data,
          to: tx.to,
          from: senderAddress,
          value: tx.value.toString(),
        }));
        const batchAsUserOp = rawTxs.length > 1;
        const eip7702Tor = {
          rpcUrl,
          walletDir,
          withoutTor: !!opts.withoutTor,
        };

        // Single EOA: eth_call each tx. Multi-call UserOp: skip isolated eth_calls —
        // later payloads often depend on earlier ones (e.g. approve then spend).
        // Batch validity is checked via bundler prepareUserOperation in the fee estimate.
        if (!batchAsUserOp) {
          for (let i = 0; i < rawTxs.length; i++) {
            const tx = rawTxs[i]!;
            await simulateTransactionOrThrow(
              client,
              {
                to: tx.to,
                from: senderAddress,
                data: tx.data,
                value: tx.value,
              },
              `Transaction ${i + 1}/${rawTxs.length}`
            );
          }
        }

        if (dryRun) {
          let needsDelegation: boolean | undefined;
          let fees: FeePreview;
          if (batchAsUserOp) {
            needsDelegation = await needsSimple7702Authorization(
              client,
              senderAddress as `0x${string}`
            );
            fees = await estimateEip7702BatchUserOpFee({
              client,
              chainId,
              senderAddress,
              calls: rawTxs,
              privateKey: senderPrivateKey,
              ...eip7702Tor,
            });
          } else {
            const parts: FeePreview[] = [];
            for (const tx of rawTxs) {
              parts.push(
                await estimateEoaTxFeePreview(client, {
                  to: tx.to,
                  from: senderAddress,
                  data: tx.data,
                  value: tx.value,
                })
              );
            }
            fees = sumEoaFeePreviews(parts);
          }
          if (opts.nonInteractive) {
            logCliJson({
              from: senderAddress,
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
            printDryRunInteractive(transactions, senderAddress, batchAsUserOp);
            if (batchAsUserOp) {
              console.log(
                chalk.dim(
                  needsDelegation
                    ? "EIP-7702 delegation will be included in the UserOp."
                    : "Account already delegates to Simple7702; UserOp skips re-authorization."
                )
              );
            }
            printFeePreview(fees);
            console.log(
              chalk.green(
                batchAsUserOp
                  ? "✔ Batched call simulation succeeded."
                  : "✔ Raw transaction simulation succeeded."
              )
            );
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
          const fees = await estimateEip7702BatchUserOpFee({
            client,
            chainId,
            senderAddress,
            calls: rawTxs,
            privateKey: senderPrivateKey,
            ...eip7702Tor,
          });
          await maybeConfirm(
            !!opts.nonInteractive,
            `Submit ${rawTxs.length} calls as one EIP-7702 UserOp from ${senderAddress}?\n  ${feeConfirmLine(fees)}`
          );

          const sent = await runQuietSpinner(
            quiet,
            txSpinner,
            {
              start: `Submitting EIP-7702 UserOp (${rawTxs.length} calls)...`,
              failure: "EIP-7702 UserOp failed.",
            },
            async () =>
              sendEip7702BatchUserOperation({
                client,
                privateKey: senderPrivateKey,
                chainId,
                calls: rawTxs,
                ...eip7702Tor,
              }),
            (t) =>
              `UserOp mined: ${t.txHash}${
                t.delegatedInUserOp ? " (delegation included)" : ""
              }`
          );

          if (opts.nonInteractive) {
            logCliJson({
              from: senderAddress,
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
          } else {
            console.log();
            console.log(chalk.green("✔ Batched EIP-7702 UserOp complete."));
            console.log(chalk.dim(`userOpHash: ${sent.userOpHash}`));
            console.log(chalk.dim(etherscanTxUrl(chainId, sent.txHash)));
          }
          return;
        }

        const walletClient = makeWalletClient(senderPrivateKey, client, rpcUrl);
        const broadcastResults: Array<{ index: number; hash: string }> = [];

        for (let i = 0; i < rawTxs.length; i++) {
          const tx = rawTxs[i]!;
          const step = `${i + 1}/${rawTxs.length}`;
          const fees = await estimateEoaTxFeePreview(client, {
            to: tx.to,
            from: senderAddress,
            data: tx.data,
            value: tx.value,
          });
          await maybeConfirm(
            !!opts.nonInteractive,
            `Send transaction (${step}) to ${tx.to} from ${senderAddress}?\n  ${feeConfirmLine(fees)}`
          );

          const sent = await runQuietSpinner(
            quiet,
            txSpinner,
            {
              start: `Sending transaction ${step}...`,
              failure: `Transaction ${step} failed.`,
            },
            async () => {
              const hash = await sendTransactionAndWait(walletClient, client, {
                to: tx.to,
                data: tx.data,
                value: tx.value,
              });
              return { hash };
            },
            (t) => `Transaction ${step} mined: ${t.hash}`
          );
          broadcastResults.push({ index: i, hash: sent.hash });
        }

        if (opts.nonInteractive) {
          logCliJson({
            from: senderAddress,
            transactions: broadcastResults.map((result) => ({
              index: result.index,
              hash: result.hash,
              explorer: etherscanTxUrl(chainId, result.hash),
              to: rawTxs[result.index]!.to,
              data: rawTxs[result.index]!.data,
              value: rawTxs[result.index]!.value.toString(),
            })),
          });
        } else {
          console.log();
          console.log(chalk.green("✔ Raw transactions complete."));
          for (const result of broadcastResults) {
            console.log(chalk.dim(etherscanTxUrl(chainId, result.hash)));
          }
        }
      } catch (e) {
        cliErrorFromCaught(e);
      } finally {
        disposePublicClient(client);
      }
      });
    });
}
