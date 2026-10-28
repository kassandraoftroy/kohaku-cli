import { preflightTornadoUnshield } from "../utils/tornado-unshield-preflight.js";
import { tornadoUnavailableAmountMessage } from "../utils/tornado-operation-limits.js";
import { startActivityLog } from "../utils/activity-log.js";
import { confirm, input, select } from "@inquirer/prompts";
import { log, spinner } from "@clack/prompts";
import chalk from "chalk";
import type { AssetAmount } from "@kohaku-eth/plugins";
import type { Command } from "commander";
import { formatUnits, getAddress, isAddress, parseUnits } from "viem";

import { makeHost } from "../host/makeHost";
import {
  exactTransferTailCall,
  planNonTornadoPrivateTransfer,
  resolveTornadoPrivateTransferCover,
} from "../lib/private-transfer.js";
import {
  prepareProtocolUnshield,
  privacyPoolsPreparedFee,
  privacyPoolsPreparedSender,
} from "../lib/privacy-pools-unshield.js";
import {
  broadcastPreparedPrivateOp,
  extractUnshieldExplorerHash,
  maxUnshieldAmountHint,
  parseUnshieldAmount,
} from "../lib/unshield-flow.js";
import { cliOptions, passwordFileOption } from "../utils/cli-command-options";
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
import { isAddressUsed } from "../utils/address-used.js";
import {
  findPublicAccountByAddress,
  makePublicAccountsStorage,
  publicAccountDerivationPath,
  selectNextUnusedPublicAccount,
} from "../utils/public-accounts";
import { stealthDelegatorPath } from "../lib/stealth/constants.js";
import {
  formatStealthSelector,
  makeStealthAccountsStorage,
  parseStealthIndex,
} from "../lib/stealth/storage.js";
import {
  assertPrivacyPoolsUnshieldSupported,
  privacyPoolsApprovedNotes,
  privacyPoolsAssetAddress,
  privacyPoolsFeeWei,
  privacyPoolsRequiredGas,
  privacyPoolsSchemeCovers,
  quotePrivacyPoolsPaymasterFeeInToken,
} from "../utils/privacy-pools-paymaster.js";
import {
  assertTornadoPaymasterConfigured,
  countTornadoWithdrawals,
  listTornadoUnspentNotes,
  TornadoCoverError,
  assertRailgunExternalRecipientAllowed,
  configureRailgunForUnshield,
  createSchemedPlugins,
  pluginIdForProtocol,
  tornadoSchemeCanCover,
  privateUnshieldAsset,
  resolveProtocolOption,
  SUPPORTED_PROTOCOLS_HELP,
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
import { isFirstProtocolSync } from "../utils/first-sync.js";
import { resolveTokenMeta } from "../utils/tokens-util";
import { resolveTornadoTailCallsGasEstimate } from "../utils/tornado-tail-gas.js";
import {
  assertPrivacyPoolsTailCallsHaveHdDelegator,
  privacyPoolsUnshieldConfirmExtraLines,
} from "../utils/privacy-pools-unshield-delegation.js";
import {
  assertTornadoTailCallsHaveHdDelegator,
  tornadoDelegationConfig,
  tornadoUnshieldConfirmExtraLines,
} from "../utils/tornado-unshield-delegation.js";
import { parseTailCalls } from "../utils/unshield-tail-calls.js";
import {
  chooseDerivationScheme,
  largerSchemeCap,
  LEGACY_SPEND_WARNING,
  unshieldSchemeFailure,
  type NoteDerivation,
} from "../utils/derivation-scheme.js";
import {
  resolveWalletDir,
  resolveWalletNameOrPrompt,
  resolveWalletPassword,
} from "../utils/wallets-util";

export type UnshieldOpts = {
  protocol?: string;
  wallet?: string;
  password?: string;
  passwordFile?: string;
  to?: string;
  next?: boolean;
  token?: string;
  amountWei?: string;
  amountFormatted?: string;
  amountMax?: boolean;
  excludeNewPools?: boolean;
  rpcUrl?: string;
  nonInteractive?: boolean;
  broadcast?: boolean;
  withoutTor?: boolean;
  tailCalls?: string;
  dataDir?: string;
  /**
   * Unshield to a fresh account and tail-call an exact transfer of the typed
   * amount to `to`. `to` is the final recipient, not the EIP-7702 delegator.
   */
  privateTransfer?: boolean;
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

/** Shared unshield flow. `private-transfer` calls this with `privateTransfer`. */
export async function runUnshield(opts: UnshieldOpts): Promise<void> {
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
      if (opts.excludeNewPools && protocol !== "tornado") {
        cliError("--exclude-new-pools is only supported with --protocol tornado.");
        return;
      }

      let tailCalls: UnshieldTailCall[] = [];
      if (opts.tailCalls !== undefined) {
        try {
          tailCalls = parseTailCalls(opts.tailCalls);
        } catch (e) {
          cliErrorFromCaught(e);
          return;
        }
      }

      const privateTransfer = !!opts.privateTransfer;
      const hasTo = !!opts.to?.trim();
      const hasNext = !!opts.next;
      if (!privateTransfer && hasTo && hasNext) {
        cliError("Provide only one of --to <address> or --next, not both.");
        return;
      }
      if (privateTransfer && hasNext) {
        cliError("private-transfer always uses a fresh account. Do not pass --next.");
        return;
      }
      if (privateTransfer && opts.tailCalls !== undefined) {
        cliError("private-transfer builds its own transfer and does not accept --tail-calls.");
        return;
      }
      if (privateTransfer && opts.amountMax) {
        cliError("private-transfer does not support --amount-max.");
        return;
      }

      const amountFlags = [
        opts.amountWei,
        opts.amountFormatted,
        privateTransfer ? undefined : opts.amountMax,
      ].filter(Boolean).length;
      if (amountFlags > 1) {
        cliError(
          privateTransfer
            ? "Provide only one of --amount-wei or --amount-formatted."
            : "Provide only one of --amount-wei, --amount-formatted, or --amount-max."
        );
        return;
      }

      if (privateTransfer) {
        if (!hasTo && opts.nonInteractive) {
          cliError("Missing --to in non-interactive mode.");
          return;
        }
        if (!opts.amountWei && !opts.amountFormatted && opts.nonInteractive) {
          cliError(
            "Missing amount in non-interactive mode. Provide --amount-wei or --amount-formatted."
          );
          return;
        }
      } else if (!hasTo && !hasNext && opts.nonInteractive) {
        cliError("Missing --to or --next in non-interactive mode.");
        return;
      } else if (
        !opts.amountWei &&
        !opts.amountFormatted &&
        !opts.amountMax &&
        opts.nonInteractive
      ) {
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
        startActivityLog({ walletDir, password, chainId, operation: opts.privateTransfer ? "private-transfer" : "unshield", protocol });
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

      if (!tokenMeta.isEth && tailCalls.some((call) => call.value > 0n)) {
        cliError(
          "--tail-calls cannot include msg.value when unshielding an ERC-20."
        );
        return;
      }
      if (protocol === "privacy-pools") {
        try {
          await assertPrivacyPoolsUnshieldSupported(rpcUrl, chainId, tokenMeta);
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
            excludeNewPools: opts.excludeNewPools,
          });
        } catch (e) {
          cliErrorFromCaught(e);
          return;
        }
      }

      const publicStorage = makePublicAccountsStorage(walletDir, mnemonic, password);
      const stealthStorage = makeStealthAccountsStorage(walletDir, password);
      let persistFreshAccountAfterBroadcast = false;

      let recipient: `0x${string}`;
      let recipientPriv: `0x${string}` | undefined;
      let recipientDerivationPath: string | undefined;
      let payee: `0x${string}` | undefined;
      let forwardLeftover = true;
      let transferAmountWei: bigint | undefined;
      let estimatedLeftoverWei = 0n;
      const freshnessClient = await makePublicClient(rpcUrl);
      const assignNextFreshPublicAccount = async (): Promise<boolean> => {
        try {
          const { account, skipped } = await selectNextUnusedPublicAccount(
            publicStorage,
            (address) => isAddressUsed(address, freshnessClient)
          );
          for (const used of skipped) {
            log.warn(
              `Public account [${used.index}] ${used.address} already has a nonce, balance, or code. Saved it and advanced to the next index.`
            );
          }
          recipient = getAddress(account.address) as `0x${string}`;
          recipientPriv = as0xPrivateKey(account.priv);
          recipientDerivationPath = publicAccountDerivationPath(account.index);
          persistFreshAccountAfterBroadcast = true;
          return true;
        } catch (e) {
          cliErrorFromCaught(e);
          return false;
        }
      };

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

      const resolvePayee = async (raw: string): Promise<`0x${string}`> => {
        const stealthIdx = parseStealthIndex(raw);
        if (stealthIdx !== null) {
          const stealthAcct = stealthStorage.getAccount(stealthIdx);
          if (!stealthAcct) {
            throw new Error(
              `Stealth account ${formatStealthSelector(stealthIdx)} not found in this wallet.`
            );
          }
          return getAddress(stealthAcct.address) as `0x${string}`;
        }
        return (await resolveAddressOrName(raw, rpcUrl)) as `0x${string}`;
      };

      if (privateTransfer) {
        try {
          if (hasTo) {
            payee = await resolvePayee(opts.to!.trim());
          } else {
            const addr = await input({
              message:
                "Recipient (address, name .eth/.gwei/.wei, or stealth selector sN). Funds are forwarded here; this account is not the delegator:",
              validate: (value) => {
                const v = value.trim();
                if (!isAddress(v) && !looksLikeName(v) && parseStealthIndex(v) === null) {
                  return "Enter an Ethereum address, a name ending in .eth, .gwei, or .wei, or a stealth selector like s0.";
                }
                return true;
              },
            });
            payee = await resolvePayee(addr.trim());
          }
        } catch (e) {
          cliErrorFromCaught(e);
          return;
        }
        if (!(await assignNextFreshPublicAccount())) return;
      } else if (hasNext) {
        if (!(await assignNextFreshPublicAccount())) return;
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
          if (!(await assignNextFreshPublicAccount())) return;
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

      if (protocol === "privacy-pools") {
        try {
          assertPrivacyPoolsTailCallsHaveHdDelegator(
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
            privateTransfer
              ? "Private transfer unshields to a fresh account you control, then forwards the exact amount to the recipient. Leftover funds stay on the fresh account."
              : "Unshielding sends a private withdrawal through the protocol relayer/broadcaster. Review the amount and recipient carefully."
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
        let plugins = await createSchemedPlugins(protocol, host, chainId);
        let plugin = plugins.signature;

        if (protocol === "railgun") {
          configureRailgunForUnshield(
            plugin,
            host,
            chainId,
            railgunSmartAccountPrivateKey(recipientPriv, publicStorage),
            railgunPimlicoBundlerUrl(chainId)
          );
        }

        if (!quiet) spin.start("Syncing private state...");
        const {
          cap: maxAmountHint,
          estimatedGasFeeWei,
          railgunGasEstimateFailed,
          railgunBalance,
          legacyCap,
          signatureCap,
          legacyTornadoNotes,
          signatureTornadoNotes,
        } = await runWithSyncProgress(
          {
            source: protocol,
            firstRun: isFirstProtocolSync(walletDir, protocol),
            onUpdate: quiet ? undefined : (message) => spin.start(message),
          },
          async () => {
            await syncPluginWithProgress(plugins.legacy, protocol);
            if (plugins.signature !== plugins.legacy) {
              await syncPluginWithProgress(plugins.signature, protocol);
            }
            if (protocol === "tornado" && opts.excludeNewPools) {
              plugins = await createSchemedPlugins(protocol, host, chainId, true);
              plugin = plugins.signature;
            }
            if (protocol === "railgun") {
              const hint = await maxUnshieldAmountHint(
                protocol,
                plugins.signature,
                tokenMeta,
                chainId,
                rpcUrl
              );
              return {
                ...hint,
                legacyCap: hint.cap,
                signatureCap: hint.cap,
                legacyTornadoNotes: [] as bigint[],
                signatureTornadoNotes: [] as bigint[],
              };
            }
            if (protocol === "tornado") {
              const probe = privateUnshieldAsset(protocol, chainId, tokenMeta, 1n);
              const legacyNotes = (
                await listTornadoUnspentNotes(plugins.legacy, probe.asset)
              ).map((note) => note.amount);
              const signatureNotes = (
                await listTornadoUnspentNotes(plugins.signature, probe.asset)
              ).map((note) => note.amount);
              const legacySum = legacyNotes.reduce((sum, note) => sum + note, 0n);
              const signatureSum = signatureNotes.reduce((sum, note) => sum + note, 0n);
              return {
                cap: largerSchemeCap(legacySum, signatureSum),
                legacyCap: legacySum,
                signatureCap: signatureSum,
                legacyTornadoNotes: legacyNotes,
                signatureTornadoNotes: signatureNotes,
              };
            }
            const legacyHint = await maxUnshieldAmountHint(
              protocol,
              plugins.legacy,
              tokenMeta,
              chainId,
              rpcUrl
            );
            const signatureHint = await maxUnshieldAmountHint(
              protocol,
              plugins.signature,
              tokenMeta,
              chainId,
              rpcUrl
            );
            const cap = largerSchemeCap(legacyHint.cap, signatureHint.cap);
            const winner = signatureHint.cap > legacyHint.cap ? signatureHint : legacyHint;
            return {
              cap,
              estimatedGasFeeWei: winner.estimatedGasFeeWei,
              railgunGasEstimateFailed:
                cap === 0n
                  ? legacyHint.railgunGasEstimateFailed &&
                    signatureHint.railgunGasEstimateFailed
                  : winner.railgunGasEstimateFailed,
              legacyCap: legacyHint.cap,
              signatureCap: signatureHint.cap,
              legacyTornadoNotes: [] as bigint[],
              signatureTornadoNotes: [] as bigint[],
            };
          }
        );
        if (spin.active) spin.stop("Private state synced.");
        const isRailgunEth = protocol === "railgun" && tokenMeta.isEth;
        const amountCap = maxAmountHint;
        const maxFormatted = formatUnits(amountCap, tokenMeta.decimals);
        const maxPromptLabel = protocol === "tornado" ? "max" : "max (after fees)";
        const maxCapLabel = isRailgunEth
          ? `WETH ${maxPromptLabel}`
          : maxPromptLabel;

        let amount: bigint | null = null;
        if (opts.amountMax) {
          if (
            railgunGasEstimateFailed &&
            (protocol !== "railgun" || isRailgunFeeToken(tokenMeta, chainId))
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

        const exceedsMax = `Amount exceeds max unshield after estimated fees for this token (${maxFormatted} ${isRailgunEth ? "WETH" : tokenMeta.symbol}).`;
        if (amount !== null && amountCap > 0n && amount > amountCap) {
          cliError(
            protocol === "tornado" || protocol === "privacy-pools"
              ? unshieldSchemeFailure({
                  legacyCap,
                  legacyLabel: `${formatUnits(legacyCap, tokenMeta.decimals)} ${tokenMeta.symbol}`,
                  signatureLabel: `${formatUnits(signatureCap, tokenMeta.decimals)} ${tokenMeta.symbol}`,
                  fallback: exceedsMax,
                })
              : exceedsMax
          );
          return;
        }

        if (amount === null) {
          if (privateTransfer) {
            const amountInput = await input({
              message: `Amount the recipient will receive (${tokenMeta.symbol}, spendable ${maxFormatted}):`,
              validate: (value) => {
                const trimmed = value.trim();
                if (!trimmed) return "Amount is required.";
                if (trimmed.toLowerCase() === "max") {
                  return "private-transfer sends an exact amount.";
                }
                try {
                  const parsed = parseUnits(trimmed, tokenMeta.decimals);
                  if (parsed <= 0n) return "Amount must be greater than zero.";
                  if (amountCap > 0n && parsed > amountCap) {
                    return `Amount exceeds spendable balance (${maxFormatted} ${tokenMeta.symbol}).`;
                  }
                } catch (e) {
                  return e instanceof Error ? e.message : String(e);
                }
                return true;
              },
            });
            try {
              amount = parseUnits(amountInput.trim(), tokenMeta.decimals);
            } catch (e) {
              cliErrorFromCaught(e);
              return;
            }
          } else {
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
                    excludeNewPools: opts.excludeNewPools,
                  });
                  if (!privateTransfer &&
                    !tornadoSchemeCanCover(signatureTornadoNotes, parsed) &&
                    !tornadoSchemeCanCover(legacyTornadoNotes, parsed)) {
                    throw new Error(tornadoUnavailableAmountMessage(
                      { signature: signatureTornadoNotes, legacy: legacyTornadoNotes }, parsed, tokenMeta
                    ));
                  }
                }
              } catch (e) {
                return e instanceof Error ? e.message : String(e);
              }
              return true;
            },
          });
          if (
            amountInput.trim().toLowerCase() === "max" &&
            railgunGasEstimateFailed &&
            (protocol !== "railgun" || isRailgunFeeToken(tokenMeta, chainId))
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
        }

        if (amount === null || amount <= 0n) {
          cliError("Amount must be greater than zero.");
          return;
        }
        // Separate binding so later --amount-max refine does not poison narrowing.
        let amountWei = amount;
        let tornadoFeeInAsset: bigint | undefined;
        if (privateTransfer) {
          if (!payee) {
            cliError("Missing private-transfer recipient.");
            return;
          }
          transferAmountWei = amountWei;
          try {
            tailCalls = [
              exactTransferTailCall(
                {
                  isEth: tokenMeta.isEth,
                  tokenAddress: tokenMeta.tokenAddress as `0x${string}`,
                },
                payee,
                transferAmountWei
              ),
            ];
            if (protocol !== "tornado") {
              const planned = planNonTornadoPrivateTransfer(transferAmountWei);
              amountWei = planned.unshieldAmountWei;
              estimatedLeftoverWei = planned.estimatedLeftoverWei;
            } else {
              forwardLeftover = false;
            }
            if (protocol === "tornado") {
              assertTornadoTailCallsHaveHdDelegator(
                recipientDerivationPath,
                tailCalls.length
              );
            } else if (protocol === "privacy-pools") {
              assertPrivacyPoolsTailCallsHaveHdDelegator(
                recipientDerivationPath,
                tailCalls.length
              );
            } else if (!recipientPriv) {
              assertRailgunExternalRecipientAllowed({
                isEth: tokenMeta.isEth,
                hasTailCalls: true,
              });
            }
          } catch (e) {
            cliErrorFromCaught(e);
            return;
          }
        }
        if (protocol === "tornado" && !privateTransfer) {
          try {
            assertTornadoUnshieldAmountForToken(chainId, amountWei, {
              isEth: tokenMeta.isEth,
              tokenAddress: tokenMeta.tokenAddress,
              symbol: tokenMeta.symbol,
              decimals: tokenMeta.decimals,
              excludeNewPools: opts.excludeNewPools,
            });
          } catch (e) {
            cliErrorFromCaught(e);
            return;
          }
        }

        const spendableLabel = (value: bigint) =>
          `${formatUnits(value, tokenMeta.decimals)} ${tokenMeta.symbol}`;
        const announceScheme = (scheme: NoteDerivation) => {
          if (scheme !== "legacy") return;
          if (quiet) console.error(LEGACY_SPEND_WARNING);
          else log.warn(LEGACY_SPEND_WARNING);
        };
        if (protocol === "privacy-pools" || (protocol === "tornado" && !privateTransfer)) {
          try {
            const legacyCanCover =
              protocol === "tornado"
                ? tornadoSchemeCanCover(legacyTornadoNotes, amountWei)
                : await privacyPoolsPluginCovers(plugins.legacy);
            const signatureCanCover =
              protocol === "tornado"
                ? tornadoSchemeCanCover(signatureTornadoNotes, amountWei)
                : await privacyPoolsPluginCovers(plugins.signature);
            const scheme = chooseDerivationScheme({
              legacyCanCover,
              signatureCanCover,
            });
            if (!scheme) {
              if (protocol === "tornado") {
                throw new Error(tornadoUnavailableAmountMessage(
                  { signature: signatureTornadoNotes, legacy: legacyTornadoNotes }, amountWei, tokenMeta
                ));
              }
              throw new Error(
                unshieldSchemeFailure({
                  legacyCap,
                  legacyLabel: spendableLabel(legacyCap),
                  signatureLabel: spendableLabel(signatureCap),
                  fallback: `Not enough spendable balance for this withdrawal (${spendableLabel(signatureCap)}).`,
                })
              );
            }
            plugin = plugins[scheme];
            announceScheme(scheme);
          } catch (e) {
            cliErrorFromCaught(e);
            return;
          }
        }

        async function privacyPoolsPluginCovers(candidate: typeof plugins.legacy): Promise<boolean> {
          const pool = privacyPoolsAssetAddress(
            tokenMeta.isEth,
            tokenMeta.tokenAddress
          );
          const listed = await (
            candidate as {
              notes?: (assets?: unknown, includeSpent?: boolean) => Promise<unknown[]>;
            }
          ).notes?.(undefined, false);
          const notes = privacyPoolsApprovedNotes(
            (listed ?? []).map((item) => {
              const note = item as {
                balance?: bigint | number | string;
                approved?: boolean;
                assetAddress?: bigint | string;
              };
              return {
                balance: note.balance == null ? 0n : BigInt(note.balance),
                approved: note.approved,
                assetAddress: note.assetAddress ?? 0n,
              };
            }),
            pool
          );
          let maxFeePerGas: bigint;
          try {
            maxFeePerGas = await fetchPimlicoMaxFeePerGas(
              railgunPimlicoBundlerUrl(chainId)
            );
          } catch {
            return false;
          }
          const hasTails = tailCalls.length > 0;
          return privacyPoolsSchemeCovers({
            notes,
            net: amountWei,
            feeFor: async (extraWithdrawals) => {
              const feeWei = privacyPoolsFeeWei(
                privacyPoolsRequiredGas({
                  isErc20: !tokenMeta.isEth,
                  extraWithdrawals,
                  hasUserTailCalls: hasTails,
                }),
                maxFeePerGas
              );
              if (tokenMeta.isEth) return feeWei;
              return quotePrivacyPoolsPaymasterFeeInToken({
                rpcUrl,
                chainId,
                feeToken: tokenMeta.tokenAddress as `0x${string}`,
                feeWei,
              });
            },
          });
        }

        let asset: AssetAmount;
        try {
          asset = privateUnshieldAsset(protocol, chainId, tokenMeta, amountWei);
        } catch (e) {
          cliErrorFromCaught(e);
          return;
        }
        let tornadoWithdrawalCount: number | undefined;
        if (protocol === "tornado" && !privateTransfer) {
          tornadoWithdrawalCount = await countTornadoWithdrawals(
            plugin,
            asset,
            amountWei
          );
          try {
            tornadoDelegationConfig({
              delegationPath: recipientDerivationPath,
              tailCallsCount: tailCalls.length,
              withdrawalCount: tornadoWithdrawalCount,
            });
          } catch (e) {
            cliErrorFromCaught(e);
            return;
          }
        }

        const prepareLabel = privateTransfer
          ? protocol === "railgun"
            ? "Building Railgun private transfer (proof + broadcaster selection)"
            : protocol === "tornado"
              ? "Building Tornado Cash private transfer (proof + paymaster)"
              : "Building Privacy Pools private transfer (proof + paymaster)"
          : protocol === "railgun"
            ? "Building Railgun unshield (proof + broadcaster selection)"
            : protocol === "tornado"
              ? "Building Tornado Cash unshield (proof + paymaster)"
              : "Building Privacy Pools unshield (proof + paymaster)";

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
            tornadoIsErc20 && !recipientDerivationPath && forwardLeftover;
          const quoteTornadoFee = tornadoIsErc20
            ? (feeWei: bigint) =>
                quoteTornadoPaymasterFeeInToken({
                  rpcUrl,
                  chainId,
                  feeToken: tokenMeta.tokenAddress as `0x${string}`,
                  feeWei,
                })
            : undefined;
          if (privateTransfer) {
            try {
              const planned = await runQuietSpinner(
                quiet,
                spin,
                {
                  start: "Choosing Tornado notes that cover the transfer and paymaster fee",
                  failure: "Could not cover this transfer with Tornado notes.",
                },
                async () => {
                  const estimateTailGas = ({
                    unshieldAmount,
                    extraWithdrawals,
                  }: {
                    unshieldAmount: bigint;
                    extraWithdrawals: number;
                  }) =>
                    resolveTornadoTailCallsGasEstimate({
                      rpcUrl,
                      account: recipient,
                      amountWei: unshieldAmount,
                      maxFeePerGas: tornadoMaxFeePerGas!,
                      extraWithdrawals,
                      userTailCalls: tailCalls,
                      asset: tokenMeta.isEth
                        ? { kind: "native" }
                        : {
                            kind: "erc20",
                            token: tokenMeta.tokenAddress as `0x${string}`,
                          },
                      feeWeiToAsset: quoteTornadoFee,
                      bakeErc20Forward: false,
                      leftoverRecipient: recipient,
                      forwardLeftover: false,
                    });
                  const coverScheme = (noteAmounts: readonly bigint[]) =>
                    resolveTornadoPrivateTransferCover({
                      noteAmounts,
                      transferAmount: transferAmountWei!,
                      isErc20: tornadoIsErc20,
                      maxFeePerGas: tornadoMaxFeePerGas!,
                      quoteFeeWei: quoteTornadoFee,
                      estimateTailGas,
                    });
                  try {
                    return {
                      scheme: "legacy" as const,
                      cover: await coverScheme(legacyTornadoNotes),
                    };
                  } catch (err) {
                    if (!(err instanceof TornadoCoverError)) throw err;
                    try {
                      return {
                        scheme: "signature" as const,
                        cover: await coverScheme(signatureTornadoNotes),
                      };
                    } catch (next) {
                      if (!(next instanceof TornadoCoverError)) throw next;
                      if (legacyCap === 0n) throw next;
                      throw new Error(
                        unshieldSchemeFailure({
                          legacyCap,
                          legacyLabel: spendableLabel(legacyCap),
                          signatureLabel: spendableLabel(signatureCap),
                          fallback: next.message,
                        })
                      );
                    }
                  }
                },
                (chosen) =>
                  `Unshield ${formatUnits(chosen.cover.unshieldAmountWei, tokenMeta.decimals)} ${tokenMeta.symbol} to cover the transfer.`
              );
              plugin = plugins[planned.scheme];
              announceScheme(planned.scheme);
              const cover = planned.cover;
              amountWei = cover.unshieldAmountWei;
              tornadoWithdrawalCount = cover.withdrawalCount;
              tornadoTailCallsGasEstimate = cover.tailGas;
              tornadoFeeInAsset = cover.estimatedFee;
              asset = privateUnshieldAsset(protocol, chainId, tokenMeta, amountWei);
              assertTornadoUnshieldAmountForToken(chainId, amountWei, {
                isEth: tokenMeta.isEth,
                tokenAddress: tokenMeta.tokenAddress,
                symbol: tokenMeta.symbol,
                decimals: tokenMeta.decimals,
                excludeNewPools: opts.excludeNewPools,
              });
              tornadoDelegationConfig({
                delegationPath: recipientDerivationPath,
                tailCallsCount: tailCalls.length,
                withdrawalCount: tornadoWithdrawalCount,
              });
              if (tornadoIsErc20) {
                tornadoErc20Tail = {
                  token: tokenMeta.tokenAddress as `0x${string}`,
                  feeReserveToken: cover.paddedFee,
                  bakeForward: false,
                };
              }
            } catch (e) {
              cliErrorFromCaught(e);
              return;
            }
          } else if (tailCalls.length > 0) {
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
                  forwardLeftover,
                }),
              (gas) =>
                gas !== undefined
                  ? `Tail-call gas estimate: ${gas.toString()}`
                  : "No tail-call gas estimate needed."
            );
          }
          if (!privateTransfer && tornadoIsErc20 && tailCalls.length > 0) {
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
                asset = privateUnshieldAsset(
                  protocol,
                  chainId,
                  tokenMeta,
                  amountWei
                );
              }
            } catch (e) {
              cliErrorFromCaught(e);
              return;
            }
          }
        }
        const privateOp = await runQuietSpinner(
          quiet,
          spin,
          { start: prepareLabel, failure: "Prepare failed." },
          async () => {
            const prepared = await prepareProtocolUnshield({
              client: rpcForHost,
              protocol,
              plugin,
              chainId,
              rpcUrl,
              tokenMeta,
              amountWei,
              recipient,
              tailCalls,
              recipientDerivationPath,
              tornadoMaxFeePerGas,
              tornadoWithdrawalCount,
              tornadoTailCallsGasEstimate,
              tornadoErc20Tail,
              tornadoForwardLeftover: forwardLeftover,
            });
            if (protocol === "tornado") await preflightTornadoUnshield(prepared);
            return prepared;
          },
          () =>
            privateTransfer
              ? "Private transfer prepared."
              : "Unshield operation prepared."
        );

        const amountLabel = `${formatUnits(amountWei, tokenMeta.decimals)} ${tokenMeta.symbol}`;
        const via =
          protocol === "railgun"
            ? "Railgun (ERC-4337 bundler)"
            : protocol === "tornado"
              ? "Tornado Cash (ERC-4337 paymaster)"
              : "Privacy Pools (ERC-4337 paymaster)";

        let fees: FeePreview;
        if (protocol === "privacy-pools") {
          const fee = privacyPoolsPreparedFee(privateOp) ?? 0n;
          fees = buildFeePreview({
            kind: "privacy-pools-paymaster",
            amount: fee,
            decimals: tokenMeta.decimals,
            asset: tokenMeta.symbol,
            note: privateTransfer
              ? "paymaster fee paid from private balance; the fresh account receives the transfer amount and any unused-gas refund (not the final recipient)"
              : "paymaster fee paid from private balance so the recipient receives the requested amount (unused gas may refund to the recipient)",
          });
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
              note: privateTransfer
                ? "paymaster fee taken from unshielded ETH; leftover stays on the fresh account (gas×price estimate; SDK quotes exact)"
                : "paymaster fee taken from unshielded ETH (gas×price estimate; SDK quotes exact)",
            });
            if (privateTransfer) tornadoFeeInAsset = feeWei;
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
            if (privateTransfer) tornadoFeeInAsset = feeToken;
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

        if (
          privateTransfer &&
          protocol === "tornado" &&
          transferAmountWei !== undefined &&
          tornadoFeeInAsset !== undefined
        ) {
          const leftover = amountWei - tornadoFeeInAsset - transferAmountWei;
          estimatedLeftoverWei = leftover > 0n ? leftover : 0n;
        }

        const transferLabel =
          privateTransfer && transferAmountWei !== undefined
            ? `${formatUnits(transferAmountWei, tokenMeta.decimals)} ${tokenMeta.symbol}`
            : undefined;
        const leftoverLabel = privateTransfer
          ? `${formatUnits(estimatedLeftoverWei, tokenMeta.decimals)} ${tokenMeta.symbol}`
          : undefined;
        const privateTransferFields = () =>
          privateTransfer && transferAmountWei !== undefined && payee
            ? {
                to: payee,
                next: recipient,
                transferAmountWei: transferAmountWei.toString(),
                transferAmountFormatted: formatUnits(
                  transferAmountWei,
                  tokenMeta.decimals
                ),
                unshieldAmountWei: amountWei.toString(),
                unshieldAmountFormatted: formatUnits(amountWei, tokenMeta.decimals),
                estimatedLeftoverWei: estimatedLeftoverWei.toString(),
              }
            : {};

        if (!opts.broadcast) {
          const amountRaw = amountWei.toString();
          const amountFormatted = formatUnits(amountWei, tokenMeta.decimals);
          const payload = opts.nonInteractive
            ? privateTransfer
              ? {
                  mode: "prepare" as const,
                  protocol,
                  token: tokenMeta.symbol,
                  ...privateTransferFields(),
                  fees,
                  privateOperation: privateOp,
                }
              : {
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
            console.log(
              chalk.bold(
                privateTransfer
                  ? "Prepared private transfer (not broadcast)"
                  : "Prepared private operation (not broadcast)"
              )
            );
            if (privateTransfer && transferLabel && payee && leftoverLabel) {
              console.log(`  Transfer: ${transferLabel}`);
              console.log(`  To: ${payee}`);
              console.log(`  Unshield: ${amountLabel}`);
              console.log(`  Fresh account: ${recipient}`);
              console.log(`  Estimated leftover on fresh account: ${leftoverLabel}`);
            }
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
            logCliJson(
              privateTransfer
                ? { ...privateTransferFields(), privateOperation: privateOp }
                : { privateOperation: privateOp },
              2
            );
            console.log(
              chalk.green(
                privateTransfer
                  ? "✔ Private transfer dry run complete."
                  : "✔ Unshield dry run complete."
              )
            );
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
          const privacyPoolsConfirmExtra =
            protocol === "privacy-pools"
              ? privacyPoolsUnshieldConfirmExtraLines({
                  recipient,
                  delegationPath: recipientDerivationPath,
                  hasTailCalls: tailCalls.length > 0,
                  sender: privacyPoolsPreparedSender(privateOp),
                })
              : [];
          const confirmExtra = [...tornadoConfirmExtra, ...privacyPoolsConfirmExtra];
          const refundLine =
            privateTransfer && protocol === "privacy-pools"
              ? "  Unused-gas refund, if any, stays on the fresh account.\n"
              : "";
          const ok = await confirm({
            message: privateTransfer
              ? `Broadcast this private transfer via ${via}?\n` +
                `  Transfer: ${transferLabel}\n` +
                `  To: ${payee}\n` +
                `  Unshield: ${amountLabel}\n` +
                `  Fresh account: ${recipient}\n` +
                `  Estimated leftover on fresh account: ${leftoverLabel}\n` +
                refundLine +
                (confirmExtra.length > 0 ? `${confirmExtra.join("\n")}\n` : "") +
                `  ${feeConfirmLine(fees)}\n` +
                `This submits the operation to the network and may be irreversible.`
              : `Broadcast this unshield via ${via}?\n` +
                `  Amount: ${amountLabel}\n` +
                `  To: ${recipient}\n` +
                (confirmExtra.length > 0 ? `${confirmExtra.join("\n")}\n` : "") +
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
          {
            start: privateTransfer ? "Broadcasting private transfer" : "Broadcasting unshield",
            failure: "Broadcast failed.",
          },
          () => broadcastPreparedPrivateOp(protocol, host, plugin, privateOp, chainId),
          () =>
            privateTransfer
              ? "Private transfer broadcast complete."
              : "Unshield broadcast complete."
        );

        if (persistFreshAccountAfterBroadcast) {
          publicStorage.addNextAccounts(1);
        }

        if (opts.nonInteractive) {
          const amountRaw = amountWei.toString();
          const amountFormatted = formatUnits(amountWei, tokenMeta.decimals);
          const explorerHash = extractUnshieldExplorerHash(relayResult);
          logCliJson(
            privateTransfer
              ? {
                  mode: "broadcast" as const,
                  protocol,
                  token: tokenMeta.symbol,
                  ...privateTransferFields(),
                  fees,
                  relay: relayResult ?? null,
                  explorerHash,
                  explorerUrl: explorerHash
                    ? etherscanTxUrl(chainId, explorerHash)
                    : null,
                }
              : {
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
                }
          );
          return;
        }
        const explorerHash = extractUnshieldExplorerHash(relayResult);
        if (explorerHash) {
          console.log(chalk.bold("Etherscan link:"));
          console.log(chalk.cyan(`  ${etherscanTxUrl(chainId, explorerHash)}`));
        } else {
          const noHashMsg =
            "Bundler response did not include a userOpHash or tx hash.";
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
        console.log(
          chalk.green(
            opts.privateTransfer
              ? "✔ Private transfer flow completed."
              : "✔ Unshield flow completed."
          )
        );
      }
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
    .addOption(passwordFileOption())
    .option(
      "--to <address>",
      "Recipient: public address, HD index address, stealth selector (s0), or name (.eth/.gwei/.wei)"
    )
    .option(
      "--next",
      "Unshield to the next fresh public account (persisted only after a successful --broadcast). An index that already has a nonce, balance, or code is saved and skipped."
    )
    .option("--exclude-new-pools", "Tornado only: use classic pools; newer pools may have small anonymity sets")
    .option("--token <address|symbol|eth>", "Token address or symbol (default: eth)")
    .option("--amount-wei <amount>", "Raw token amount in wei/base units")
    .option("--amount-formatted <amount>", "Decimal amount (converted using token decimals)")
    .option(
      "--amount-max",
      "Unshield the larger single-scheme amount (Railgun: after estimated fees; Privacy Pools: one scheme after its own estimated fees; Tornado: one scheme's full note balance)"
    )
    .option("--rpc-url <url>", cliOptions.rpcUrl)
    .option("--non-interactive", cliOptions.nonInteractiveShieldLike)
    .option(
      "--broadcast",
      "Submit via protocol broadcaster (omit to print the prepared private operation only)"
    )
    .option(
      "--tail-calls <target:calldata[:value],...>",
      "Ordered calls appended to the UserOperation execution (optional value in hex or decimal wei; ERC-20 tails cannot include value). Tornado and Privacy Pools require --next, a stored public HD --to, or a stored stealth --to"
    )
    .option("--without-tor", cliOptions.withoutTor)
    .option("--dataDir <path>", cliOptions.dataDir)
    .action((opts: UnshieldOpts) => runUnshield(opts));
}
