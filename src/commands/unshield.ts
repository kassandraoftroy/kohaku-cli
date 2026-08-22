import { confirm, input, select } from "@inquirer/prompts";
import { log, spinner } from "@clack/prompts";
import chalk from "chalk";
import type { AssetAmount } from "@kohaku-eth/plugins";
import type { Command } from "commander";
import { formatUnits, getAddress, isAddress, parseUnits } from "viem";

import { makeHost } from "../host/makeHost";
import {
  assertPrivacyPoolsRelayFeeWithinCap,
  broadcastPreparedPrivateOp,
  extractUnshieldExplorerHash,
  maxUnshieldAmountHint,
  parseUnshieldAmount,
  privacyPoolsRelayerFeeWei,
} from "../lib/unshield-flow.js";
import { cliOptions } from "../utils/cli-command-options";
import { cliError, cliErrorFromCaught } from "../utils/cli-errors";
import {
  buildFeePreview,
  feeConfirmLine,
  formatFeeAmount,
  printFeePreview,
  type FeePreview,
} from "../utils/fee-preview.js";
import { looksLikeName, resolveAddressOrName } from "../utils/resolve-name.js";
import {
  logCliJson,
  manageSpinner,
  quietNonInteractive,
  runQuietSpinner,
} from "../utils/cli-quiet";
import { readSeedKeystore } from "../utils/mnemonic";
import {
  findPublicAccountByAddress,
  makePublicAccountsStorage,
  publicAccountDerivationPath,
} from "../utils/public-accounts";
import { stealthDelegatorPath } from "../lib/stealth/constants.js";
import {
  formatStealthSelector,
  makeStealthAccountsStorage,
  parseStealthIndex,
} from "../lib/stealth/storage.js";
import {
  ETH_AS_ERC20,
  assertPpErc20TokenWhitelisted,
  assertTornadoPaymasterConfigured,
  countTornadoWithdrawals,
  assertRailgunExternalRecipientAllowed,
  configureRailgunForUnshield,
  createProtocolPlugin,
  pluginIdForProtocol,
  railgunErc20AssetAmount,
  railgunNativeEthAssetAmount,
  railgunUnshieldOptions,
  resolveProtocolOption,
  SUPPORTED_PROTOCOLS_HELP,
  tornadoUnshieldOptions,
  type UnshieldTailCall,
  type TornadoErc20TailForward,
  type SupportedProtocol,
} from "../utils/plugins";
import {
  assertTornadoPaymasterTokenSupported,
  assertTornadoUnshieldAmountForToken,
} from "../utils/tornado-pools.js";
import {
  computeRailgunMaxUnshieldAmount,
  estimateRailgunBundlerFeeWei,
  isRailgunFeeToken,
  railgunUnshieldFeeBps,
} from "../utils/railgun-unshield-max.js";
import {
  railgunTailFundAsset,
  resolveRailgunTailCallsGasEstimate,
} from "../utils/railgun-tail-gas.js";
import { fetchPimlicoMaxFeePerGas } from "../utils/pimlico-gas.js";
import {
  estimateTornadoPaymasterFee,
  padTornadoTailForwardFee,
  resolveTornadoPrepareMaxFeePerGas,
  tornadoWithdrawalCallGasLimit,
} from "../utils/tornado-paymaster-gas.js";
import { quoteTornadoPaymasterFeeInToken } from "../utils/tornado-paymaster-quote.js";
import {
  DEFAULT_DATA_DIR,
  getRpcChainIdMatchingWallet,
  makePublicClient,
  disposePublicClient,
  railgunPimlicoBundlerUrl,
  resolveRpcUrl,
} from "../utils/rpc";
import { withTor } from "../utils/tor.js";
import {
  runWithSyncProgress,
  syncPluginWithProgress,
} from "../utils/sync-progress.js";
import { primeRailgunSubsquidProgressIfNeeded } from "../utils/railgun-subsquid-progress.js";
import { resolveTokenMeta } from "../utils/tokens-util";
import { resolveTornadoTailCallsGasEstimate } from "../utils/tornado-tail-gas.js";
import {
  assertTornadoTailCallsHaveHdDelegator,
  tornadoDelegationConfig,
  tornadoUnshieldConfirmExtraLines,
} from "../utils/tornado-unshield-delegation.js";
import { parseTailCalls } from "../utils/unshield-tail-calls.js";
import {
  resolveWalletDir,
  resolveWalletNameOrPrompt,
  resolveWalletPassword,
} from "../utils/wallets-util";

type UnshieldOpts = {
  protocol?: string;
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
  withoutTor?: boolean;
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

/** Next fresh public account without advancing storage (persist after successful broadcast). */
function takeNextFreshPublicAccount(
  storage: ReturnType<typeof makePublicAccountsStorage>
): { address: string; priv: string; index: number } {
  return storage.peekNextAccounts(1)[0]!;
}

/** 7702 UserOp signer: recipient key when we have it, else an unused HD key. */
function railgunSmartAccountPrivateKey(
  recipientPriv: `0x${string}` | undefined,
  storage: ReturnType<typeof makePublicAccountsStorage>
): `0x${string}` {
  if (recipientPriv) return recipientPriv;
  return as0xPrivateKey(takeNextFreshPublicAccount(storage).priv);
}

export function registerUnshieldCommand(program: Command): void {
  program
    .command("unshield")
    .description("Unshield private balance to a public address (via protocol relayer/broadcaster)")
    .option(
      "--protocol <protocol>",
      `Protocol: ${SUPPORTED_PROTOCOLS_HELP} (or set DEFAULT_PRIVACY_PROTOCOL)`
    )
    .option("--wallet <name>", cliOptions.walletPickList)
    .option("--password <password>", cliOptions.password)
    .option(
      "--to <address>",
      "Recipient: public address, HD index address, stealth selector (s0), or name (.eth/.gwei/.wei)"
    )
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
      "Ordered calls appended to Tornado / Railgun UserOperation execution (optional value in hex or decimal wei; Tornado ERC-20 tails cannot include value)"
    )
    .option("--without-tor", cliOptions.withoutTor)
    .option("--dataDir <path>", cliOptions.dataDir)
    .action(async (opts: UnshieldOpts) => {
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

      let tailCalls: UnshieldTailCall[] = [];
      if (opts.tailCalls !== undefined) {
        if (protocol === "privacy-pools") {
          cliError("--tail-calls is not supported for privacy-pools.");
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
          assertTornadoPaymasterTokenSupported(chainId, {
            isEth: tokenMeta.isEth,
            tokenAddress: tokenMeta.tokenAddress,
            symbol: tokenMeta.symbol,
          });
        } catch (e) {
          cliErrorFromCaught(e);
          return;
        }
        if (tailCalls.length > 0 && !tokenMeta.isEth) {
          const withValue = tailCalls.some((c) => c.value > 0n);
          if (withValue) {
            cliError(
              "Tornado --tail-calls cannot include msg.value when unshielding an ERC-20: the 7702 account does not receive native ETH."
            );
            return;
          }
        }
      }

      const publicStorage = makePublicAccountsStorage(walletDir, mnemonic, password);
      const stealthStorage = makeStealthAccountsStorage(walletDir, password);
      let persistFreshAccountAfterBroadcast = false;

      let recipient: `0x${string}`;
      let recipientPriv: `0x${string}` | undefined;
      let recipientDerivationPath: string | undefined;

      const applyPublicRecipient = (address: `0x${string}`) => {
        recipient = getAddress(address) as `0x${string}`;
        const publicAcct = findPublicAccountByAddress(publicStorage, recipient);
        if (publicAcct) {
          recipientPriv = as0xPrivateKey(publicAcct.priv);
          recipientDerivationPath = publicAccountDerivationPath(publicAcct.index);
          return;
        }
        const stealthAcct = stealthStorage.findByAddress(recipient);
        if (stealthAcct) {
          recipientPriv = as0xPrivateKey(stealthAcct.priv);
          recipientDerivationPath = stealthDelegatorPath(stealthAcct.stealthIndex);
          return;
        }
        recipientPriv = undefined;
        recipientDerivationPath = undefined;
      };

      const applyStealthRecipient = (stealthIndex: number) => {
        const stealthAcct = stealthStorage.getAccount(stealthIndex);
        if (!stealthAcct) {
          throw new Error(
            `Stealth account ${formatStealthSelector(stealthIndex)} not found in this wallet.`
          );
        }
        recipient = getAddress(stealthAcct.address) as `0x${string}`;
        recipientPriv = as0xPrivateKey(stealthAcct.priv);
        recipientDerivationPath = stealthDelegatorPath(stealthIndex);
      };

      if (hasNext) {
        const fresh = takeNextFreshPublicAccount(publicStorage);
        recipient = getAddress(fresh.address) as `0x${string}`;
        recipientPriv = as0xPrivateKey(fresh.priv);
        recipientDerivationPath = publicAccountDerivationPath(fresh.index);
        persistFreshAccountAfterBroadcast = true;
      } else if (hasTo) {
        const raw = opts.to!.trim();
        try {
          const stealthIdx = parseStealthIndex(raw);
          if (stealthIdx !== null) {
            applyStealthRecipient(stealthIdx);
          } else {
            const resolved = (await resolveAddressOrName(
              raw,
              rpcUrl
            )) as `0x${string}`;
            applyPublicRecipient(resolved);
          }
        } catch (e) {
          cliErrorFromCaught(e);
          return;
        }
      } else {
        const existingAccounts = publicStorage.getAccounts();
        const stealthAccounts = stealthStorage.getAccounts();
        const NEXT_FRESH = "__next_fresh__";
        const CUSTOM_ADDR = "__custom__";

        const choices: Array<{ value: string; name: string }> = [];
        choices.push({
          value: NEXT_FRESH,
          name: "Generate next fresh public account (--next)",
        });
        choices.push({
          value: CUSTOM_ADDR,
          name: "Enter a custom receiving address",
        });
        for (const acct of existingAccounts) {
          choices.push({
            value: acct.address,
            name: `[${acct.index}] ${acct.address}`,
          });
        }
        for (const acct of stealthAccounts) {
          choices.push({
            value: `stealth:${acct.stealthIndex}`,
            name: `[${formatStealthSelector(acct.stealthIndex)}] ${acct.address}`,
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
            message: "Enter recipient address or name (.eth/.gwei/.wei):",
            validate: (value) => {
              const v = value.trim();
              if (!isAddress(v) && !looksLikeName(v))
                return "Enter a valid Ethereum address or a name ending in .eth, .gwei, or .wei.";
              return true;
            },
          });
          try {
            const resolved = (await resolveAddressOrName(
              addr.trim(),
              rpcUrl
            )) as `0x${string}`;
            applyPublicRecipient(resolved);
          } catch (e) {
            cliErrorFromCaught(e);
            return;
          }
        } else if (chosen.startsWith("stealth:")) {
          try {
            applyStealthRecipient(Number(chosen.slice("stealth:".length)));
          } catch (e) {
            cliErrorFromCaught(e);
            return;
          }
        } else {
          applyPublicRecipient(getAddress(chosen) as `0x${string}`);
        }
      }

      if (protocol === "railgun" && !recipientPriv) {
        try {
          assertRailgunExternalRecipientAllowed({
            isEth: tokenMeta.isEth,
            hasTailCalls: tailCalls.length > 0,
          });
        } catch (e) {
          cliErrorFromCaught(e);
          return;
        }
      }

      if (protocol === "tornado") {
        try {
          assertTornadoTailCallsHaveHdDelegator(
            recipientDerivationPath,
            tailCalls.length
          );
        } catch (e) {
          cliErrorFromCaught(e);
          return;
        }
      }

      if (!opts.nonInteractive) {
        console.log(
          chalk.yellow(
            "Unshielding sends a private withdrawal through the protocol relayer/broadcaster. Review the amount and recipient carefully."
          )
        );
      }

      const rpcForHost = await makePublicClient(rpcUrl);
      const spin = manageSpinner(spinner(), quietNonInteractive(opts.nonInteractive));
      const quiet = quietNonInteractive(opts.nonInteractive);
      const useTor = !opts.withoutTor;
      try {
        await withTor(
          useTor,
          {
            rpcUrl,
            walletDir,
            onStatus: (message) => {
              spin.start(message);
            },
          },
          async () => {
        // Tor onStatus leaves the spinner running; stop before prompts / work.
        if (spin.active) spin.stop("Tor ready.");

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
            railgunSmartAccountPrivateKey(recipientPriv, publicStorage),
            railgunPimlicoBundlerUrl(chainId)
          );
        }

        const {
          cap: maxAmountHint,
          privacyPoolsLargestNote,
          estimatedGasFeeWei,
          railgunGasEstimateFailed,
          railgunBalance,
        } = await runWithSyncProgress(
          {
            protocol,
            onUpdate: quiet ? undefined : (message) => spin.start(message),
          },
          async () => {
            const priming = primeRailgunSubsquidProgressIfNeeded(
              protocol,
              chainId
            );
            await syncPluginWithProgress(plugin, protocol);
            await priming;
            return maxUnshieldAmountHint(protocol, plugin, tokenMeta, chainId);
          }
        );
        if (spin.active) spin.stop("Private state synced.");
        const isRailgunEth = protocol === "railgun" && tokenMeta.isEth;
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
                  assertTornadoUnshieldAmountForToken(chainId, parsed, {
                    isEth: tokenMeta.isEth,
                    tokenAddress: tokenMeta.tokenAddress,
                    symbol: tokenMeta.symbol,
                    decimals: tokenMeta.decimals,
                  });
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

        if (amount === null || amount <= 0n) {
          cliError("Amount must be greater than zero.");
          return;
        }
        // Separate binding so later --amount-max refine does not poison narrowing.
        let amountWei = amount;
        if (protocol === "tornado") {
          try {
            assertTornadoUnshieldAmountForToken(chainId, amountWei, {
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

        let asset: AssetAmount;
        try {
          asset =
            protocol === "railgun"
              ? tokenMeta.isEth
                ? railgunNativeEthAssetAmount(chainId, amountWei)
                : railgunErc20AssetAmount(tokenMeta.tokenAddress, amountWei)
              : {
                  asset: {
                    __type: "erc20",
                    contract: (tokenMeta.isEth
                      ? ETH_AS_ERC20
                      : tokenMeta.tokenAddress) as `0x${string}`,
                  },
                  amount: amountWei,
                };
        } catch (e) {
          cliErrorFromCaught(e);
          return;
        }
        const tornadoWithdrawalCount =
          protocol === "tornado"
            ? await countTornadoWithdrawals(plugin, asset, amountWei)
            : undefined;
        if (protocol === "tornado") {
          try {
            tornadoDelegationConfig({
              delegationPath: recipientDerivationPath,
              tailCallsCount: tailCalls.length,
              withdrawalCount: tornadoWithdrawalCount!,
            });
          } catch (e) {
            cliErrorFromCaught(e);
            return;
          }
        }

        const prepareLabel =
          protocol === "railgun"
            ? "Building Railgun unshield (proof + broadcaster selection)"
            : protocol === "tornado"
              ? "Building Tornado Cash unshield (proof + paymaster)"
              : "Building Privacy Pools unshield (proof + relayer quote)";

        const prepareUnshield = (
          plugin as unknown as {
            prepareUnshield: (
              a: AssetAmount,
              t: `0x${string}`,
              options?: unknown
            ) => Promise<unknown>;
          }
        ).prepareUnshield.bind(plugin);
        if (protocol === "tornado") {
          assertTornadoPaymasterConfigured(chainId);
        }
        let tornadoMaxFeePerGas: bigint | undefined;
        let tornadoTailCallsGasEstimate: bigint | undefined;
        let tornadoErc20Tail: TornadoErc20TailForward | undefined;
        let railgunTailCallsGasEstimate: bigint | undefined;
        if (protocol === "tornado") {
          tornadoMaxFeePerGas = await resolveTornadoPrepareMaxFeePerGas(chainId);
          const tornadoIsErc20 = !tokenMeta.isEth;
          const bakeErc20Forward =
            tornadoIsErc20 && !recipientDerivationPath;
          if (tailCalls.length > 0) {
            tornadoTailCallsGasEstimate = await runQuietSpinner(
              quiet,
              spin,
              {
                start: "Estimating Tornado tail-call gas (state override)",
                failure: "Tail-call gas estimate failed.",
              },
              () =>
                resolveTornadoTailCallsGasEstimate({
                  rpcUrl,
                  account: recipient,
                  amountWei,
                  maxFeePerGas: tornadoMaxFeePerGas!,
                  extraWithdrawals: Math.max(0, (tornadoWithdrawalCount ?? 1) - 1),
                  userTailCalls: tailCalls,
                  asset: tokenMeta.isEth
                    ? { kind: "native" }
                    : {
                        kind: "erc20",
                        token: tokenMeta.tokenAddress as `0x${string}`,
                      },
                  feeWeiToAsset: tornadoIsErc20
                    ? (feeWei) =>
                        quoteTornadoPaymasterFeeInToken({
                          rpcUrl,
                          chainId,
                          feeToken: tokenMeta.tokenAddress as `0x${string}`,
                          feeWei,
                        })
                    : undefined,
                  bakeErc20Forward,
                  leftoverRecipient: recipient,
                }),
              (gas) =>
                gas !== undefined
                  ? `Tail-call gas estimate: ${gas.toString()}`
                  : "No tail-call gas estimate needed."
            );
          }
          if (tornadoIsErc20 && tailCalls.length > 0) {
            try {
              const callGasLimit = tornadoWithdrawalCallGasLimit(
                Math.max(0, (tornadoWithdrawalCount ?? 1) - 1),
                tornadoTailCallsGasEstimate,
                true
              );
              const feeWei = estimateTornadoPaymasterFee(tornadoMaxFeePerGas!, {
                callGasLimit,
                isERC20: true,
              });
              const feeReserveToken = await quoteTornadoPaymasterFeeInToken({
                rpcUrl,
                chainId,
                feeToken: tokenMeta.tokenAddress as `0x${string}`,
                feeWei: padTornadoTailForwardFee(feeWei),
              });
              if (amountWei <= feeReserveToken) {
                cliError(
                  `Withdrawal amount is too small to cover the Tornado paymaster fee (need ~${formatUnits(feeReserveToken, tokenMeta.decimals)} ${tokenMeta.symbol} for gas).`
                );
                return;
              }
              tornadoErc20Tail = {
                token: tokenMeta.tokenAddress as `0x${string}`,
                feeReserveToken,
                bakeForward: bakeErc20Forward,
              };
            } catch (e) {
              cliErrorFromCaught(e);
              return;
            }
          }
        } else if (protocol === "railgun" && tailCalls.length > 0) {
          railgunTailCallsGasEstimate = await runQuietSpinner(
            quiet,
            spin,
            {
              start:
                "Estimating Railgun tail-call gas (state override with post-unshield funds)",
              failure: "Tail-call gas estimate failed.",
            },
            () =>
              resolveRailgunTailCallsGasEstimate({
                rpcUrl,
                account: recipient,
                amountWei,
                userTailCalls: tailCalls,
                asset: railgunTailFundAsset(tokenMeta),
              }),
            (gas) =>
              gas !== undefined
                ? `Tail-call gas estimate: ${gas.toString()}`
                : "No tail-call gas estimate needed."
          );

          // --amount-max used a static UserOp gas reserve; refine once we know
          // how expensive the user tails are (fee-token unshields only).
          if (
            opts.amountMax &&
            isRailgunFeeToken(tokenMeta, chainId) &&
            railgunBalance != null &&
            railgunBalance > 0n &&
            railgunTailCallsGasEstimate !== undefined
          ) {
            try {
              const refined = await computeRailgunMaxUnshieldAmount({
                chainId,
                balance: railgunBalance,
                tokenMeta,
                tailCallsGasEstimate: railgunTailCallsGasEstimate,
              });
              if (refined.amount < amountWei) {
                if (refined.amount <= 0n) {
                  cliError(
                    "No spendable balance for --amount-max after reserving estimated bundler gas for --tail-calls."
                  );
                  return;
                }
                if (!quiet) {
                  log.info(
                    `Refining --amount-max for tail-call gas: ${formatUnits(amountWei, tokenMeta.decimals)} → ${formatUnits(refined.amount, tokenMeta.decimals)} ${isRailgunEth ? "WETH" : tokenMeta.symbol}`
                  );
                }
                amountWei = refined.amount;
                asset =
                  tokenMeta.isEth
                    ? railgunNativeEthAssetAmount(chainId, amountWei)
                    : railgunErc20AssetAmount(tokenMeta.tokenAddress, amountWei);
              }
            } catch (e) {
              cliErrorFromCaught(e);
              return;
            }
          }
        }
        const railgunOptions = railgunUnshieldOptions(tailCalls);
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
                    amountWei,
                    tornadoMaxFeePerGas!,
                    recipientDerivationPath,
                    tornadoWithdrawalCount!,
                    tailCalls,
                    tornadoTailCallsGasEstimate,
                    tornadoErc20Tail
                  )
                )
              : protocol === "railgun" && railgunOptions
                ? prepareUnshield(asset, recipient, railgunOptions)
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

        const amountLabel = `${formatUnits(amountWei, tokenMeta.decimals)} ${tokenMeta.symbol}`;
        const via =
          protocol === "railgun"
            ? "Railgun (ERC-4337 bundler)"
            : protocol === "tornado"
              ? "Tornado Cash (ERC-4337 paymaster)"
              : "Privacy Pools relayer";

        let fees: FeePreview;
        if (protocol === "privacy-pools") {
          const rel = privacyPoolsRelayerFeeWei(privateOp, amountWei);
          if (!rel) {
            fees = buildFeePreview({
              kind: "privacy-pools-relayer",
              amount: 0n,
              decimals: tokenMeta.decimals,
              asset: tokenMeta.symbol,
              note: "relayer fee bps missing from prepared op",
            });
          } else {
            fees = buildFeePreview({
              kind: "privacy-pools-relayer",
              amount: rel.feeWei,
              decimals: tokenMeta.decimals,
              asset: tokenMeta.symbol,
              relayFeeBps: rel.relayFeeBps,
              note: "relayer fee = amount × relayFeeBps / 10000",
            });
          }
        } else if (protocol === "tornado") {
          const tornadoIsErc20 = !tokenMeta.isEth;
          const callGasLimit = tornadoWithdrawalCallGasLimit(
            Math.max(0, (tornadoWithdrawalCount ?? 1) - 1),
            tornadoTailCallsGasEstimate,
            tornadoIsErc20
          );
          const feeWei = estimateTornadoPaymasterFee(tornadoMaxFeePerGas!, {
            callGasLimit,
            isERC20: tornadoIsErc20,
          });
          if (!tornadoIsErc20) {
            fees = buildFeePreview({
              kind: "tornado-paymaster",
              amount: feeWei,
              decimals: 18,
              asset: "ETH",
              maxFeePerGasWei: tornadoMaxFeePerGas,
              gasLimit: callGasLimit,
              note: "paymaster fee taken from unshielded ETH (gas×price estimate; SDK quotes exact)",
            });
          } else {
            const feeForQuote =
              tailCalls.length > 0 ? padTornadoTailForwardFee(feeWei) : feeWei;
            let feeToken = tornadoErc20Tail?.feeReserveToken;
            if (feeToken === undefined) {
              try {
                feeToken = await quoteTornadoPaymasterFeeInToken({
                  rpcUrl,
                  chainId,
                  feeToken: tokenMeta.tokenAddress as `0x${string}`,
                  feeWei: feeForQuote,
                });
              } catch (e) {
                cliErrorFromCaught(e);
                return;
              }
            }
            fees = buildFeePreview({
              kind: "tornado-paymaster",
              amount: feeToken,
              decimals: tokenMeta.decimals,
              asset: tokenMeta.symbol,
              maxFeePerGasWei: tornadoMaxFeePerGas,
              gasLimit: callGasLimit,
              components: [
                {
                  label: "gas × maxFeePerGas",
                  amount: feeWei.toString(),
                  amountFormatted: formatFeeAmount(feeWei, 18, "ETH"),
                  asset: "ETH",
                },
              ],
              note:
                tailCalls.length > 0
                  ? `paymaster fee paid in ${tokenMeta.symbol} via on-chain quoteWeiInToken (15% tail leftover pad included)`
                  : `paymaster fee paid in ${tokenMeta.symbol} via on-chain quoteWeiInToken (same TWAP as UserOp)`,
            });
          }
        } else {
          // railgun
          const bps = railgunUnshieldFeeBps(chainId);
          const treasuryFee = (amountWei * BigInt(bps)) / 10_000n;
          const components: NonNullable<FeePreview["components"]> = [
            {
              label: `treasury (${bps} bps)`,
              amount: treasuryFee.toString(),
              amountFormatted: formatFeeAmount(
                treasuryFee,
                tokenMeta.decimals,
                tokenMeta.symbol
              ),
              asset: tokenMeta.symbol,
            },
          ];
          let bundlerFee = 0n;
          let maxFeePerGas: bigint | undefined;
          try {
            maxFeePerGas = await fetchPimlicoMaxFeePerGas(
              railgunPimlicoBundlerUrl(chainId)
            );
            bundlerFee = estimateRailgunBundlerFeeWei(maxFeePerGas, {
              nativeUnwrap: tokenMeta.isEth,
              tailCallsGasEstimate: railgunTailCallsGasEstimate,
            });
            components.unshift({
              label: isRailgunFeeToken(tokenMeta, chainId)
                ? "bundler (from this asset)"
                : "bundler (from WETH balance)",
              amount: bundlerFee.toString(),
              amountFormatted: formatFeeAmount(bundlerFee, 18, "ETH"),
              asset: "ETH",
            });
          } catch {
            // leave bundler fee as 0
          }
          const primaryAmount = isRailgunFeeToken(tokenMeta, chainId)
            ? bundlerFee + treasuryFee
            : treasuryFee;
          const primaryAsset = isRailgunFeeToken(tokenMeta, chainId)
            ? "ETH"
            : tokenMeta.symbol;
          const primaryDecimals = isRailgunFeeToken(tokenMeta, chainId)
            ? 18
            : tokenMeta.decimals;
          fees = buildFeePreview({
            kind: "railgun-paymaster",
            amount: primaryAmount,
            decimals: primaryDecimals,
            asset: primaryAsset,
            maxFeePerGasWei: maxFeePerGas,
            gasLimit: railgunTailCallsGasEstimate,
            components,
            note: isRailgunFeeToken(tokenMeta, chainId)
              ? railgunTailCallsGasEstimate !== undefined
                ? "bundler + treasury estimate (includes state-override tail gas); actual may differ"
                : "bundler + treasury estimate; actual may differ"
              : railgunTailCallsGasEstimate !== undefined
                ? "primary = treasury; bundler paid separately in WETH (tail gas in estimate)"
                : "primary = treasury; bundler paid separately in WETH",
          });
        }

        if (!opts.broadcast) {
          const amountRaw = amountWei.toString();
          const amountFormatted = formatUnits(amountWei, tokenMeta.decimals);
          const payload = opts.nonInteractive
            ? {
                mode: "prepare" as const,
                protocol,
                recipient,
                token: tokenMeta.symbol,
                amountWei: amountRaw,
                amountFormatted,
                fees,
                privateOperation: privateOp,
              }
            : { privateOperation: privateOp, fees };
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
            printFeePreview(fees);
            console.log();
            console.log(chalk.bold("JSON (pipe or save for tooling):"));
            logCliJson({ privateOperation: privateOp }, 2);
            console.log(chalk.green("✔ Unshield dry run complete."));
          }
          return;
        }

        if (!opts.nonInteractive) {
          // Blank line so @inquirer confirm is not drawn over the clack stop line.
          console.log();
          const tornadoConfirmExtra =
            protocol === "tornado"
              ? tornadoUnshieldConfirmExtraLines({
                  recipient,
                  delegationPath: recipientDerivationPath,
                  hasTailCalls: tailCalls.length > 0,
                  withdrawalCount: tornadoWithdrawalCount ?? 1,
                })
              : [];
          const ok = await confirm({
            message:
              `Broadcast this unshield via ${via}?\n` +
              `  Amount: ${amountLabel}\n` +
              `  To: ${recipient}\n` +
              (tornadoConfirmExtra.length > 0
                ? `${tornadoConfirmExtra.join("\n")}\n`
                : "") +
              `  ${feeConfirmLine(fees)}\n` +
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
          const amountRaw = amountWei.toString();
          const amountFormatted = formatUnits(amountWei, tokenMeta.decimals);
          const explorerHash = extractUnshieldExplorerHash(relayResult, protocol);
          logCliJson({
            mode: "broadcast" as const,
            protocol,
            recipient,
            token: tokenMeta.symbol,
            amountWei: amountRaw,
            amountFormatted,
            fees,
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
          }
        );
      } catch (e) {
        if (spin.active) spin.stop("Failed.", 1);
        cliErrorFromCaught(e);
        return;
      } finally {
        disposePublicClient(rpcForHost);
      }

      if (!opts.nonInteractive) {
        console.log(chalk.green("✔ Unshield flow completed."));
      }
    });
}
