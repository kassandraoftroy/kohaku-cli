import { confirm, input, select } from "@inquirer/prompts";
import { log, spinner } from "@clack/prompts";
import chalk from "chalk";
import type { AssetAmount } from "@kohaku-eth/plugins";
import type { Command } from "commander";
import { formatUnits, getAddress, isAddress, parseUnits } from "ethers";

import { makeHost } from "../host/makeHost";
import {
  assertPrivacyPoolsRelayFeeWithinCap,
  broadcastPreparedPrivateOp,
  extractUnshieldExplorerHash,
  maxUnshieldAmountHint,
  parseUnshieldAmount,
} from "../lib/unshield-flow.js";
import { cliOptions } from "../utils/cli-command-options";
import { cliError, cliErrorFromCaught } from "../utils/cli-errors";
import {
  logCliJson,
  quietNonInteractive,
  runQuietSpinner,
} from "../utils/cli-quiet";
import { readSeedKeystore } from "../utils/mnemonic";
import {
  findPublicAccountByAddress,
  makePublicAccountsStorage,
  publicAccountDerivationPath,
} from "../utils/public-accounts";
import {
  ETH_AS_ERC20,
  assertPpErc20TokenWhitelisted,
  assertTornadoEthOnly,
  assertTornadoPaymasterConfigured,
  assertTornadoUnshieldAmount,
  countTornadoWithdrawals,
  configureRailgunForUnshield,
  createProtocolPlugin,
  isSupportedProtocol,
  pluginIdForProtocol,
  railgunNativeEthAssetAmount,
  SUPPORTED_PROTOCOLS_HELP,
  tornadoUnshieldOptions,
  type UnshieldTailCall,
  type SupportedProtocol,
} from "../utils/plugins";
import { isRailgunFeeToken } from "../utils/railgun-unshield-max.js";
import {
  DEFAULT_DATA_DIR,
  getRpcChainIdMatchingWallet,
  makeEthersProvider,
  railgunPimlicoBundlerUrl,
  resolveRpcUrl,
} from "../utils/rpc";
import { resolveTokenMeta } from "../utils/tokens-util";
import { resolveTornadoPrepareMaxFeePerGas } from "../utils/tornado-paymaster-gas.js";
import { resolveTornadoTailCallsGasEstimate } from "../utils/tornado-tail-gas.js";
import {
  resolveWalletDir,
  resolveWalletNameOrPrompt,
  resolveWalletPassword,
} from "../utils/wallets-util";

type UnshieldOpts = {
  protocol?: SupportedProtocol;
  wallet?: string;
  password?: string;
  to?: string;
  next?: boolean;
  token?: string;
  amountWei?: string;
  amountFormatted?: string;
  amountMax?: boolean;
  rpcUrl?: string;
  nonInteractive?: boolean;
  broadcast?: boolean;
  tailCalls?: string;
  dataDir?: string;
};

function etherscanTxUrl(chainId: bigint, txHash: string): string {
  const host = chainId === 11155111n ? "sepolia.etherscan.io" : "etherscan.io";
  return `https://${host}/tx/${txHash}`;
}

function as0xPrivateKey(priv: string): `0x${string}` {
  return (priv.startsWith("0x") ? priv : `0x${priv}`) as `0x${string}`;
}

function parseTailCalls(raw: string): UnshieldTailCall[] {
  const entries = raw.split(",").map((entry) => entry.trim());
  if (entries.length === 0 || entries.some((entry) => !entry)) {
    throw new Error(
      "--tail-calls must contain comma-separated TARGET:CALLDATA or TARGET:CALLDATA:VALUE entries."
    );
  }

  return entries.map((entry, index) => {
    const parts = entry.split(":").map((part) => part.trim());
    if (parts.length < 2 || parts.length > 3 || parts.some((part) => !part)) {
      throw new Error(
        `Invalid tail call at index ${index}: expected TARGET:CALLDATA or TARGET:CALLDATA:VALUE.`
      );
    }

    const [target, data, valueRaw] = parts;
    if (!isAddress(target!)) {
      throw new Error(`Invalid tail call target at index ${index}: ${target}`);
    }
    if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(data!)) {
      throw new Error(
        `Invalid tail call calldata at index ${index}: expected 0x-prefixed, byte-aligned hex.`
      );
    }

    let value = 0n;
    if (valueRaw !== undefined) {
      if (!/^0x[0-9a-fA-F]+$/.test(valueRaw) && !/^[0-9]+$/.test(valueRaw)) {
        throw new Error(
          `Invalid tail call value at index ${index}: expected 0x-hex or decimal wei (${valueRaw}).`
        );
      }
      try {
        value = BigInt(valueRaw);
      } catch {
        throw new Error(
          `Invalid tail call value at index ${index}: ${valueRaw}`
        );
      }
      if (value < 0n) {
        throw new Error(`Invalid tail call value at index ${index}: must be >= 0.`);
      }
    }

    return {
      to: getAddress(target!) as `0x${string}`,
      data: data! as `0x${string}`,
      value,
    };
  });
}

/** Next fresh public account without advancing storage (persist after successful broadcast). */
function takeNextFreshPublicAccount(
  storage: ReturnType<typeof makePublicAccountsStorage>
): { address: string; priv: string; index: number } {
  return storage.peekNextAccounts(1)[0]!;
}

export function registerUnshieldCommand(program: Command): void {
  program
    .command("unshield")
    .description("Unshield private balance to a public address (via protocol relayer/broadcaster)")
    .requiredOption("--protocol <protocol>", `Protocol: ${SUPPORTED_PROTOCOLS_HELP}`)
    .option("--wallet <name>", cliOptions.walletPickList)
    .option("--password <password>", cliOptions.password)
    .option("--to <address>", "Public recipient address")
    .option(
      "--next",
      "Unshield to the next fresh public account (persisted only after a successful --broadcast)"
    )
    .option("--token <address|symbol|eth>", "Token address or symbol (default: eth)")
    .option("--amount-wei <amount>", "Raw token amount in wei/base units")
    .option("--amount-formatted <amount>", "Decimal amount (converted using token decimals)")
    .option(
      "--amount-max",
      "Unshield the maximum spendable amount (Railgun: after estimated gas + treasury fee; Privacy Pools: largest single note; Tornado: full note balance)"
    )
    .option("--rpc-url <url>", cliOptions.rpcUrl)
    .option("--non-interactive", cliOptions.nonInteractiveShieldLike)
    .option(
      "--broadcast",
      "Submit via protocol broadcaster (omit to print the prepared private operation only)"
    )
    .option(
      "--tail-calls <target:calldata[:value],...>",
      "Ordered calls appended to the Tornado UserOperation (optional value in hex or decimal wei)"
    )
    .option("--dataDir <path>", cliOptions.dataDir)
    .action(async (opts: UnshieldOpts) => {
      if (!isSupportedProtocol(opts.protocol)) {
        cliError(`--protocol must be "${SUPPORTED_PROTOCOLS_HELP}".`);
        return;
      }
      const protocol = opts.protocol;

      let tailCalls: UnshieldTailCall[] = [];
      if (opts.tailCalls !== undefined) {
        if (protocol === "privacy-pools") {
          cliError("--tail-calls is not supported for privacy-pools.");
          return;
        }
        if (protocol === "railgun") {
          cliError(
            "--tail-calls is not supported for railgun by the currently installed Railgun SDK."
          );
          return;
        }
        try {
          tailCalls = parseTailCalls(opts.tailCalls);
        } catch (e) {
          cliErrorFromCaught(e);
          return;
        }
      }

      const hasTo = !!opts.to?.trim();
      const hasNext = !!opts.next;
      if (hasTo && hasNext) {
        cliError("Provide only one of --to <address> or --next, not both.");
        return;
      }

      const amountFlags = [opts.amountWei, opts.amountFormatted, opts.amountMax].filter(
        Boolean
      ).length;
      if (amountFlags > 1) {
        cliError(
          "Provide only one of --amount-wei, --amount-formatted, or --amount-max."
        );
        return;
      }

      if (!hasTo && !hasNext && opts.nonInteractive) {
        cliError("Missing --to or --next in non-interactive mode.");
        return;
      }
      if (!opts.amountWei && !opts.amountFormatted && !opts.amountMax && opts.nonInteractive) {
        cliError(
          "Missing amount in non-interactive mode. Provide --amount-wei, --amount-formatted, or --amount-max."
        );
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

      const publicStorage = makePublicAccountsStorage(walletDir, mnemonic, password);
      let persistFreshAccountAfterBroadcast = false;

      let recipient: `0x${string}`;
      let recipientPriv: `0x${string}` | undefined;
      let recipientDerivationPath: string | undefined;
      if (hasNext) {
        const fresh = takeNextFreshPublicAccount(publicStorage);
        recipient = getAddress(fresh.address) as `0x${string}`;
        recipientPriv = as0xPrivateKey(fresh.priv);
        recipientDerivationPath = publicAccountDerivationPath(fresh.index);
        persistFreshAccountAfterBroadcast = true;
      } else if (hasTo) {
        const raw = opts.to!.trim();
        if (!isAddress(raw)) {
          cliError(`Invalid --to address: ${raw}`);
          return;
        }
        recipient = getAddress(raw) as `0x${string}`;
        const acct = findPublicAccountByAddress(publicStorage, recipient);
        recipientPriv = acct ? as0xPrivateKey(acct.priv) : undefined;
        recipientDerivationPath = acct
          ? publicAccountDerivationPath(acct.index)
          : undefined;
      } else {
        const existingAccounts = publicStorage.getAccounts();
        const NEXT_FRESH = "__next_fresh__";
        const CUSTOM_ADDR = "__custom__";

        const choices: Array<{ value: string; name: string }> = [];
        choices.push({
          value: NEXT_FRESH,
          name: "Generate next fresh public account (--next)",
        });
        if (protocol === "privacy-pools") {
          choices.push({
            value: CUSTOM_ADDR,
            name: "Enter a custom address",
          });
        }
        for (const acct of existingAccounts) {
          choices.push({
            value: acct.address,
            name: `[${acct.index}] ${acct.address}`,
          });
        }

        const chosen = await select<string>({
          message: `Recipient address (${tokenMeta.symbol} will be unshielded here)`,
          choices,
        });

        if (chosen === NEXT_FRESH) {
          const fresh = takeNextFreshPublicAccount(publicStorage);
          recipient = getAddress(fresh.address) as `0x${string}`;
          recipientPriv = as0xPrivateKey(fresh.priv);
          recipientDerivationPath = publicAccountDerivationPath(fresh.index);
          persistFreshAccountAfterBroadcast = true;
        } else if (chosen === CUSTOM_ADDR) {
          const addr = await input({
            message: "Enter recipient address (0x...):",
            validate: (value) => {
              if (!isAddress(value.trim())) return "Invalid Ethereum address.";
              return true;
            },
          });
          recipient = getAddress(addr.trim()) as `0x${string}`;
        } else {
          recipient = getAddress(chosen) as `0x${string}`;
          const acct = findPublicAccountByAddress(publicStorage, recipient);
          recipientPriv = acct ? as0xPrivateKey(acct.priv) : undefined;
          recipientDerivationPath = acct
            ? publicAccountDerivationPath(acct.index)
            : undefined;
        }
      }

      if (protocol === "railgun" && !recipientPriv) {
        cliError(
          "Railgun unshield requires a recipient public account from this wallet (use --next or --to with a stored public address)."
        );
        return;
      }
      if (protocol === "tornado" && !recipientDerivationPath) {
        cliError(
          "Tornado unshield requires --to to be a public account from this wallet (or use --next) so that account can sign the EIP-7702 delegation."
        );
        return;
      }

      if (!opts.nonInteractive) {
        console.log(
          chalk.yellow(
            "Unshielding sends a private withdrawal through the protocol relayer/broadcaster. Review the amount and recipient carefully."
          )
        );
      }

      const rpcForHost = await makeEthersProvider(rpcUrl);
      const spin = spinner();
      const quiet = quietNonInteractive(opts.nonInteractive);
      try {
        const host = await makeHost({
          rpc: rpcForHost,
          walletDir,
          password,
          mnemonic,
          pluginId: pluginIdForProtocol(protocol),
          chainId,
        });
        const plugin = await createProtocolPlugin(protocol, host, chainId);

        if (protocol === "railgun") {
          configureRailgunForUnshield(
            plugin,
            host,
            chainId,
            recipientPriv!,
            railgunPimlicoBundlerUrl(chainId)
          );
        }

        if (
          (protocol === "privacy-pools" || protocol === "tornado") &&
          "sync" in plugin &&
          typeof plugin.sync === "function"
        ) {
          const sync = (plugin as { sync: () => Promise<void> }).sync;
          const syncLabel =
            protocol === "tornado"
              ? "Syncing Tornado Cash state…"
              : "Syncing private state…";
          await runQuietSpinner(
            quiet,
            spin,
            { start: syncLabel, failure: "Sync failed." },
            () => sync.call(plugin),
            () => "Private state synced."
          );
        }

        const isRailgunEth = protocol === "railgun" && tokenMeta.isEth;
        const {
          cap: maxAmountHint,
          privacyPoolsLargestNote,
          estimatedGasFeeWei,
          railgunGasEstimateFailed,
        } = await maxUnshieldAmountHint(protocol, plugin, tokenMeta, chainId);
        const maxFormatted = formatUnits(maxAmountHint, tokenMeta.decimals);
        const maxPromptLabel = privacyPoolsLargestNote
            ? "max (largest single note)"
            : protocol === "railgun"
              ? "max (after fees)"
              : "max";
        const maxCapLabel = isRailgunEth
          ? `WETH ${maxPromptLabel}`
          : maxPromptLabel;

        let amount: bigint | null = null;
        if (opts.amountMax) {
          if (
            protocol === "railgun" &&
            isRailgunFeeToken(tokenMeta, chainId) &&
            railgunGasEstimateFailed
          ) {
            cliError(
              "Could not fetch bundler gas price to compute --amount-max. Retry when Pimlico is reachable."
            );
            return;
          }
          if (maxAmountHint <= 0n) {
            cliError(
              "No spendable balance for --amount-max (or amount too small after estimated fees)."
            );
            return;
          }
          amount = maxAmountHint;
          if (!quiet && estimatedGasFeeWei != null && estimatedGasFeeWei > 0n) {
            log.info(
              `Reserving ~${formatUnits(estimatedGasFeeWei, 18)} ETH for estimated bundler gas.`
            );
          }
        } else if (opts.amountWei) {
          amount = BigInt(opts.amountWei);
        } else if (opts.amountFormatted) {
          amount = parseUnits(opts.amountFormatted, tokenMeta.decimals);
        }

        if (
          amount !== null &&
          maxAmountHint > 0n &&
          amount > maxAmountHint
        ) {
          const scope = privacyPoolsLargestNote
            ? "largest Privacy Pools note for this token (one withdrawal uses one note)"
            : protocol === "railgun"
              ? "max unshield after estimated fees for this token"
              : "shielded balance for this token";
          cliError(
            `Amount exceeds ${scope} (${maxFormatted} ${isRailgunEth ? "WETH" : tokenMeta.symbol}).`
          );
          return;
        }

        if (amount === null) {
          const amountInput = await input({
            message: `Amount to unshield (${tokenMeta.symbol}, ${maxCapLabel}: ${maxFormatted}, or "max"):`,
            validate: (value) => {
              if (!value.trim()) return "Amount is required.";
              try {
                const parsed = parseUnshieldAmount(
                  value,
                  tokenMeta.decimals,
                  maxAmountHint
                );
                if (protocol === "tornado") {
                  assertTornadoUnshieldAmount(chainId, parsed);
                }
              } catch (e) {
                return e instanceof Error ? e.message : String(e);
              }
              return true;
            },
          });
          if (
            amountInput.trim().toLowerCase() === "max" &&
            protocol === "railgun" &&
            isRailgunFeeToken(tokenMeta, chainId) &&
            railgunGasEstimateFailed
          ) {
            cliError(
              "Could not fetch bundler gas price to compute max. Enter an explicit amount or retry."
            );
            return;
          }
          try {
            amount = parseUnshieldAmount(
              amountInput,
              tokenMeta.decimals,
              maxAmountHint
            );
          } catch (e) {
            cliErrorFromCaught(e);
            return;
          }
        }

        if (amount <= 0n) {
          cliError("Amount must be greater than zero.");
          return;
        }
        if (protocol === "tornado") {
          try {
            assertTornadoUnshieldAmount(chainId, amount);
          } catch (e) {
            cliErrorFromCaught(e);
            return;
          }
        }

        let asset: AssetAmount;
        try {
          asset =
            tokenMeta.isEth && protocol === "railgun"
              ? railgunNativeEthAssetAmount(chainId, amount)
              : {
                  asset: {
                    __type: "erc20",
                    contract: (tokenMeta.isEth
                      ? ETH_AS_ERC20
                      : tokenMeta.tokenAddress) as `0x${string}`,
                  },
                  amount,
                };
        } catch (e) {
          cliErrorFromCaught(e);
          return;
        }
        const tornadoWithdrawalCount =
          protocol === "tornado"
            ? await countTornadoWithdrawals(plugin, asset, amount)
            : undefined;

        const prepareLabel =
          protocol === "railgun"
            ? "Building Railgun unshield (proof + broadcaster selection)…"
            : protocol === "tornado"
              ? "Building Tornado Cash unshield (proof + paymaster)…"
              : "Building Privacy Pools unshield (proof + relayer quote)…";

        const prepareUnshield = (
          plugin as unknown as {
            prepareUnshield: (
              a: AssetAmount,
              t: `0x${string}`,
              options?:
                | { mode: "paymaster" }
                | { mode: "relayer" }
            ) => Promise<unknown>;
          }
        ).prepareUnshield.bind(plugin);
        if (protocol === "tornado") {
          assertTornadoPaymasterConfigured(chainId);
        }
        let tornadoMaxFeePerGas: bigint | undefined;
        let tornadoTailCallsGasEstimate: bigint | undefined;
        if (protocol === "tornado") {
          tornadoMaxFeePerGas = await resolveTornadoPrepareMaxFeePerGas(chainId);
          if (tailCalls.length > 0) {
            tornadoTailCallsGasEstimate = await runQuietSpinner(
              quiet,
              spin,
              {
                start: "Estimating Tornado tail-call gas (state override)…",
                failure: "Tail-call gas estimate failed.",
              },
              () =>
                resolveTornadoTailCallsGasEstimate({
                  rpcUrl,
                  account: recipient,
                  amountWei: amount,
                  maxFeePerGas: tornadoMaxFeePerGas!,
                  extraWithdrawals: Math.max(0, (tornadoWithdrawalCount ?? 1) - 1),
                  userTailCalls: tailCalls,
                  asset: tokenMeta.isEth
                    ? { kind: "native" }
                    : {
                        kind: "erc20",
                        token: tokenMeta.tokenAddress as `0x${string}`,
                      },
                }),
              (gas) =>
                gas !== undefined
                  ? `Tail-call gas estimate: ${gas.toString()}`
                  : "No tail-call gas estimate needed."
            );
          }
        }
        const privateOp = await runQuietSpinner(
          quiet,
          spin,
          { start: prepareLabel, failure: "Prepare failed." },
          () =>
            protocol === "tornado"
              ? prepareUnshield(
                  asset,
                  recipient,
                  tornadoUnshieldOptions(
                    recipient,
                    amount,
                    tornadoMaxFeePerGas!,
                    recipientDerivationPath!,
                    tornadoWithdrawalCount!,
                    tailCalls,
                    tornadoTailCallsGasEstimate
                  )
                )
              : prepareUnshield(asset, recipient),
          () => "Unshield operation prepared."
        );

        if (protocol === "privacy-pools") {
          await assertPrivacyPoolsRelayFeeWithinCap(
            privateOp,
            rpcUrl,
            chainId
          );
        }

        const amountLabel = `${formatUnits(amount, tokenMeta.decimals)} ${tokenMeta.symbol}`;
        const via =
          protocol === "railgun"
            ? "Railgun (ERC-4337 bundler)"
            : protocol === "tornado"
              ? "Tornado Cash (ERC-4337 paymaster)"
              : "Privacy Pools relayer";

        if (!opts.broadcast) {
          const amountRaw = amount.toString();
          const amountFormatted = formatUnits(amount, tokenMeta.decimals);
          const payload = opts.nonInteractive
            ? {
                mode: "prepare" as const,
                protocol,
                recipient,
                token: tokenMeta.symbol,
                amountWei: amountRaw,
                amountFormatted,
                privateOperation: privateOp,
              }
            : { privateOperation: privateOp };
          if (opts.nonInteractive) {
            logCliJson(payload);
          } else {
            console.log();
            console.log(chalk.bold("Prepared private operation (not broadcast)"));
            console.log(
              chalk.dim(
                `This object is not a normal EIP-1559 transaction — submit it with the SDK ${chalk.bold("broadcast()")} method, the ${via}, or compatible tooling.`
              )
            );
            console.log(
              chalk.dim(
                "Add --broadcast to submit from this CLI (same confirmation as before)."
              )
            );
            console.log();
            console.log(chalk.bold("JSON (pipe or save for tooling):"));
            logCliJson({ privateOperation: privateOp }, 2);
            console.log(chalk.green("✔ Unshield dry run complete."));
          }
          return;
        }

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

        const relayResult = await runQuietSpinner(
          quiet,
          spin,
          { start: "Broadcasting unshield", failure: "Broadcast failed." },
          () => broadcastPreparedPrivateOp(protocol, host, plugin, privateOp, chainId),
          () => "Unshield broadcast complete."
        );

        if (persistFreshAccountAfterBroadcast) {
          publicStorage.addNextAccounts(1);
        }

        if (opts.nonInteractive) {
          const amountRaw = amount.toString();
          const amountFormatted = formatUnits(amount, tokenMeta.decimals);
          const explorerHash = extractUnshieldExplorerHash(relayResult, protocol);
          logCliJson({
            mode: "broadcast" as const,
            protocol,
            recipient,
            token: tokenMeta.symbol,
            amountWei: amountRaw,
            amountFormatted,
            relay: relayResult ?? null,
            explorerHash,
            explorerUrl: explorerHash
              ? etherscanTxUrl(chainId, explorerHash)
              : null,
          });
          return;
        }
        const explorerHash = extractUnshieldExplorerHash(relayResult, protocol);
        if (explorerHash) {
          console.log(chalk.bold("Etherscan link:"));
          console.log(chalk.cyan(`  ${etherscanTxUrl(chainId, explorerHash)}`));
        } else {
          const noHashMsg =
            protocol === "privacy-pools"
              ? "Relayer response did not include an on-chain tx hash."
              : protocol === "tornado"
                ? "Tornado paymaster bundler did not return a userOpHash or tx hash."
                : "Bundler response did not include a userOpHash or tx hash.";
          console.log(chalk.dim(noHashMsg));
        }
      } catch (e) {
        cliErrorFromCaught(e);
        return;
      } finally {
        rpcForHost.destroy();
      }

      if (!opts.nonInteractive) {
        console.log(chalk.green("✔ Unshield flow completed."));
      }
    });
}
