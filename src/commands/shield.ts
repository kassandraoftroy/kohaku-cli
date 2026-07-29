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
import {
  formatPublicAccountBalanceLabel,
  listPublicAccountsWithBalance,
  shieldTransactionConfirmMessage,
} from "../lib/shield-flow.js";
import { cliOptions } from "../utils/cli-command-options";
import {
  logCliJson,
  manageSpinner,
  quietNonInteractive,
  runQuietSpinner,
} from "../utils/cli-quiet";
import { cliError, cliErrorFromCaught } from "../utils/cli-errors";
import { resolveAddressOrName } from "../utils/resolve-name.js";
import { jsonStringifyWithBigInt } from "../utils/json-bigint";
import {
  DEFAULT_DATA_DIR,
  getRpcChainIdMatchingWallet,
  makeEthersProvider,
  resolveRpcUrl,
} from "../utils/rpc";
import { withTor } from "../utils/tor";
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
  assertTornadoEthOnly,
  assertTornadoShieldAmount,
  createProtocolPlugin,
  ETH_AS_ERC20,
  pluginIdForProtocol,
  prepareProtocolShield,
  resolveProtocolOption,
  SUPPORTED_PROTOCOLS_HELP,
  type SupportedProtocol,
} from "../utils/plugins";

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

type FeeOverrides = {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
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
  shieldTxs: Array<{ to: string; data: string; value: bigint }>,
  approve: { to: string; data: string; value: bigint } | null,
  tokenMeta: { symbol: string; decimals: number },
  senderAddress: string
): void {
  console.log();
  console.log(chalk.bold("Planned transactions (not submitted)"));
  console.log(
    chalk.dim("Add --broadcast to sign and send these transactions on-chain from the CLI.")
  );
  console.log();
  const shieldStepOffset = approve ? 1 : 0;
  const totalSteps = shieldStepOffset + shieldTxs.length;
  if (approve) {
    const o: TxPayloadJson = {
      data: approve.data,
      to: approve.to,
      from: senderAddress,
      value: approve.value.toString(),
    };
    console.log(
      chalk.cyan(`Approve ${tokenMeta.symbol} ERC20 tx (1/${totalSteps}):`),
      jsonStringifyWithBigInt(o)
    );
    console.log();
  }
  for (let i = 0; i < shieldTxs.length; i++) {
    const shieldTx = shieldTxs[i]!;
    const step = shieldStepOffset + i + 1;
    const o: TxPayloadJson = {
      data: shieldTx.data,
      to: shieldTx.to,
      from: senderAddress,
      value: shieldTx.value.toString(),
    };
    const valueLabel =
      shieldTxs.length > 1
        ? ` — ${formatUnits(shieldTx.value, tokenMeta.decimals)} ${tokenMeta.symbol}`
        : "";
    console.log(
      chalk.cyan(`Shield operation tx (${step}/${totalSteps})${valueLabel}:`),
      jsonStringifyWithBigInt(o)
    );
    if (i < shieldTxs.length - 1) {
      console.log();
    }
  }
}

function toShieldTxs(
  op: unknown,
  opts?: { allowMultiple?: boolean }
): Array<{ to: string; data: string; value: bigint }> {
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

  if (txs.length === 0) {
    throw new Error("prepareShield() returned no transactions.");
  }

  if (!opts?.allowMultiple && txs.length !== 1) {
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
      "Sign and submit on-chain (omit to print transaction payloads only)"
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
          assertTornadoEthOnly(tokenMeta.isEth);
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
          assertTornadoShieldAmount(chainId, amount);
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
                  assertTornadoShieldAmount(chainId, parsed);
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
              assertTornadoShieldAmount(chainId, amount);
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
        let shieldTxs: Array<{ to: string; data: string; value: bigint }>;
        try {
          const op = await prepareProtocolShield(plugin, protocol, asset as AssetAmount);
          shieldTxs = toShieldTxs(op, { allowMultiple: protocol === "tornado" });
        } catch (e) {
          const msg = e instanceof Error ? e.message : JSON.stringify(e);
          cliError(msg);
          return;
        }
        const tx = shieldTxs[0]!;

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
          for (const stx of shieldTxs) {
            transactions.push({
              data: stx.data,
              to: stx.to,
              from: senderAddress,
              value: stx.value.toString(),
            });
          }
          if (opts.nonInteractive) {
            logCliJson({ transactions });
          } else {
            if (txSpinner.active) txSpinner.stop();
            printShieldDryRunInteractive(shieldTxs, approve, tokenMeta, senderAddress);
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
              `Send approval transaction (1/2): approve ${tx.to} to spend ${amountPreview} (from ${senderAddress})?`,
              txSpinner
            );
            const approveTx = await runQuietSpinner(
              quiet,
              txSpinner,
              { start: "Sending approval 1/2...", failure: "Approval failed." },
              async () => {
                const t = await erc20.approve(tx.to, amount/*, feeOverrides*/);
                await t.wait();
                return t;
              },
              (t) => `Approval mined (1/2): ${t.hash}`
            );
            broadcastTransactions.push({ type: "approval", hash: approveTx.hash });
          }
        }

        for (let i = 0; i < shieldTxs.length; i++) {
          const stx = shieldTxs[i]!;
          const shieldStep =
            shieldTxs.length > 1
              ? `${i + 1}/${shieldTxs.length}`
              : hasApproval
                ? "2/2"
                : "1/1";
          await maybeConfirm(
            !!opts.nonInteractive,
            shieldTransactionConfirmMessage({
              step: shieldStep,
              txValue: stx.value,
              shieldTxs,
              tokenMeta,
              senderAddress,
            }),
            txSpinner
          );
          await simulateTransactionOrThrow(
            rpcForHost,
            {
              to: stx.to,
              from: senderAddress,
              data: stx.data,
              value: stx.value,
              gasLimit: 2000000n,
            },
            shieldTxs.length > 1
              ? `Shield transaction (${shieldStep})`
              : "Shield transaction"
          );
          const sent = await runQuietSpinner(
            quiet,
            txSpinner,
            {
              start: `Sending shield tx ${shieldStep}...`,
              failure: "Shield transaction failed.",
            },
            async () => {
              const s = await signer.sendTransaction({
                to: stx.to,
                data: stx.data,
                value: stx.value,
                gasLimit: 2000000,
              });
              await s.wait();
              return s;
            },
            (s) => `Shield tx mined (${shieldStep}): ${s.hash}`
          );
          broadcastTransactions.push({ type: "shield", hash: sent.hash });
        }
        if (opts.nonInteractive) {
          logCliJson({ transactions: broadcastTransactions });
          return;
        }
          }
        );
      } catch (e) {
        if (txSpinner.active) txSpinner.stop("Failed.", 1);
        cliErrorFromCaught(e);
        return;
      } finally {
        rpcForHost.destroy();
      }

      if (!opts.nonInteractive) {
        if (broadcastTransactions.length > 0) {
          console.log(chalk.bold("Etherscan links:"));
          for (const tx of broadcastTransactions) {
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
