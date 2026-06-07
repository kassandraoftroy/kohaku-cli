import { confirm, input, select } from "@inquirer/prompts";
import { createPPv1Broadcaster } from "@kohaku-eth/privacy-pools";
import { log, spinner } from "@clack/prompts";
import chalk from "chalk";
import type { AssetAmount, Host } from "@kohaku-eth/plugins";
import type { Command } from "commander";
import { formatUnits, getAddress, isAddress, parseUnits } from "ethers";

import { makeHost } from "../host/makeHost";
import { cliOptions } from "../utils/cli-command-options";
import {
  logCliJson,
  quietNonInteractive,
  runQuietSpinner,
} from "../utils/cli-quiet";
import { cliError, cliErrorFromCaught } from "../utils/cli-errors";
import {
  DEFAULT_DATA_DIR,
  getRpcChainIdMatchingWallet,
  makeEthersProvider,
  railgunPimlicoBundlerUrl,
  resolveRpcUrl,
} from "../utils/rpc";
import { resolveTokenMeta, wethAddressForChain } from "../utils/tokens-util";
import {
  resolveWalletDir,
  resolveWalletNameOrPrompt,
  resolveWalletPassword,
} from "../utils/wallets-util";
import { readSeedKeystore } from "../utils/mnemonic";
import { assertPrivacyPoolsRelayFeeWithinCap } from "../lib/unshield-flow.js";
import {
  findPublicAccountByAddress,
  makePublicAccountsStorage,
} from "../utils/public-accounts";
import {
  ETH_AS_ERC20,
  PRIVACY_POOLS_BROADCASTER_URL,
  assertPpErc20TokenWhitelisted,
  configureRailgunForUnshield,
  createProtocolPlugin,
  isSupportedProtocol,
  pluginIdForProtocol,
  railgunNativeEthAssetAmount,
  type SupportedProtocol,
} from "../utils/plugins";

type UnshieldOpts = {
  protocol?: SupportedProtocol;
  wallet?: string;
  password?: string;
  to?: string;
  next?: boolean;
  token?: string;
  amountWei?: string;
  amountFormatted?: string;
  rpcUrl?: string;
  nonInteractive?: boolean;
  broadcast?: boolean;
  dataDir?: string;
};

function etherscanTxUrl(chainId: bigint, txHash: string): string {
  const host = chainId === 11155111n ? "sepolia.etherscan.io" : "etherscan.io";
  return `https://${host}/tx/${txHash}`;
}

function findTxHashDeep(value: unknown): string | null {
  if (typeof value === "string") {
    return /^0x[a-fA-F0-9]{64}$/.test(value) ? value : null;
  }
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const hash = findTxHashDeep(item);
      if (hash) return hash;
    }
    return null;
  }
  const obj = value as Record<string, unknown>;
  for (const key of ["bundleTxHash", "txHash", "transactionHash", "hash"] as const) {
    const hash = findTxHashDeep(obj[key]);
    if (hash) return hash;
  }
  for (const v of Object.values(obj)) {
    const hash = findTxHashDeep(v);
    if (hash) return hash;
  }
  return null;
}

function as0xPrivateKey(priv: string): `0x${string}` {
  return (priv.startsWith("0x") ? priv : `0x${priv}`) as `0x${string}`;
}

/** Next fresh public account without advancing storage (persist after successful broadcast). */
function takeNextFreshPublicAccount(
  storage: ReturnType<typeof makePublicAccountsStorage>
): { address: string; priv: string } {
  return storage.peekNextAccounts(1)[0]!;
}

type PpNoteForMax = { balance: bigint; assetAddress: bigint | string };

function ppNoteAssetLower(n: PpNoteForMax): string {
  if (typeof n.assetAddress === "bigint") {
    return `0x${n.assetAddress.toString(16).padStart(40, "0")}`.toLowerCase();
  }
  return String(n.assetAddress).toLowerCase();
}

/**
 * Upper bound for one `prepareUnshield` call: Privacy Pools uses the largest
 * single note (protocol cannot merge notes in one proof); Railgun uses summed
 * balance for the token from `balance()`.
 */
async function maxUnshieldAmountHint(
  protocol: SupportedProtocol,
  plugin: unknown,
  tokenMeta: { isEth: boolean; tokenAddress: string; decimals: number },
  chainId: bigint
): Promise<{ cap: bigint; privacyPoolsLargestNote: boolean }> {
  if (protocol === "privacy-pools") {
    const targetAddr = tokenMeta.isEth
      ? ETH_AS_ERC20.toLowerCase()
      : tokenMeta.tokenAddress.toLowerCase();
    let largest = 0n;
    try {
      const notes = await (
        plugin as unknown as {
          notes: (assets?: unknown[], includeSpent?: boolean) => Promise<
            PpNoteForMax[]
          >;
        }
      ).notes(undefined, false);
      for (const n of notes) {
        if (ppNoteAssetLower(n) !== targetAddr || n.balance <= 0n) continue;
        if (n.balance > largest) largest = n.balance;
      }
    } catch {
      // ignore
    }
    return { cap: largest, privacyPoolsLargestNote: true };
  }

  let targetAddr = tokenMeta.tokenAddress.toLowerCase();
  if (tokenMeta.isEth) {
    const weth = wethAddressForChain(chainId);
    targetAddr = weth ? weth.toLowerCase() : ETH_AS_ERC20.toLowerCase();
  }

  let sum = 0n;
  try {
    const balances: AssetAmount[] = await (
      plugin as unknown as { balance: (a: unknown) => Promise<AssetAmount[]> }
    ).balance(undefined);
    for (const row of balances) {
      const asset = row.asset as { __type?: string; contract?: unknown } | undefined;
      if (!asset || asset.__type !== "erc20") continue;
      let addr: string;
      if (typeof asset.contract === "string") addr = asset.contract.toLowerCase();
      else if (typeof asset.contract === "bigint")
        addr = `0x${asset.contract.toString(16).padStart(40, "0")}`;
      else continue;
      if (addr === targetAddr) sum += row.amount;
    }
  } catch {
    // ignore
  }
  return { cap: sum, privacyPoolsLargestNote: false };
}

async function broadcastPreparedPrivateOp(
  protocol: SupportedProtocol,
  host: Host,
  plugin: unknown,
  operation: unknown
): Promise<unknown> {
  if (protocol === "railgun") {
    await (plugin as { broadcast: (op: unknown) => Promise<void> }).broadcast(
      operation
    );
    return undefined;
  }
  const broadcaster = createPPv1Broadcaster(host, {
    broadcasterUrl: PRIVACY_POOLS_BROADCASTER_URL,
  });
  return await broadcaster.broadcast(operation as never);
}

export function registerUnshieldCommand(program: Command): void {
  program
    .command("unshield")
    .description("Unshield private balance to a public address (via protocol relayer/broadcaster)")
    .requiredOption("--protocol <protocol>", "Protocol: railgun | privacy-pools")
    .option("--wallet <name>", cliOptions.walletPickList)
    .option("--password <password>", cliOptions.password)
    .option("--to <address>", "Public recipient address")
    .option(
      "--next",
      "Unshield to the next fresh public account (persisted only after a successful --broadcast)"
    )
    .option("--token <address|eth>", "Token address (default: eth)")
    .option("--amount-wei <amount>", "Raw token amount in wei/base units")
    .option("--amount-formatted <amount>", "Decimal amount (converted using token decimals)")
    .option("--rpc-url <url>", cliOptions.rpcUrl)
    .option("--non-interactive", cliOptions.nonInteractiveShieldLike)
    .option(
      "--broadcast",
      "Submit via protocol broadcaster (omit to print the prepared private operation only)"
    )
    .option("--dataDir <path>", cliOptions.dataDir)
    .action(async (opts: UnshieldOpts) => {
      if (!isSupportedProtocol(opts.protocol)) {
        cliError('--protocol must be "railgun" or "privacy-pools".');
        return;
      }
      const protocol = opts.protocol;

      const hasTo = !!opts.to?.trim();
      const hasNext = !!opts.next;
      if (hasTo && hasNext) {
        cliError("Provide only one of --to <address> or --next, not both.");
        return;
      }

      if (opts.amountWei && opts.amountFormatted) {
        cliError("Provide only one of --amount-wei or --amount-formatted.");
        return;
      }

      if (!hasTo && !hasNext && opts.nonInteractive) {
        cliError("Missing --to or --next in non-interactive mode.");
        return;
      }
      if (!opts.amountWei && !opts.amountFormatted && opts.nonInteractive) {
        cliError(
          "Missing amount in non-interactive mode. Provide --amount-wei or --amount-formatted."
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

      const publicStorage = makePublicAccountsStorage(walletDir, mnemonic, password);
      let persistFreshAccountAfterBroadcast = false;

      let recipient: `0x${string}`;
      let recipientPriv: `0x${string}` | undefined;
      if (hasNext) {
        const fresh = takeNextFreshPublicAccount(publicStorage);
        recipient = getAddress(fresh.address) as `0x${string}`;
        recipientPriv = as0xPrivateKey(fresh.priv);
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
      } else {
        const existingAccounts = publicStorage.getAccounts();
        const NEXT_FRESH = "__next_fresh__";
        const CUSTOM_ADDR = "__custom__";

        const choices: Array<{ value: string; name: string }> = [];
        choices.push({
          value: NEXT_FRESH,
          name: "Generate next fresh public account (--next)",
        });
        if (protocol !== "railgun") {
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
        }
      }

      if (protocol === "railgun" && !recipientPriv) {
        cliError(
          "Railgun unshield requires a recipient public account from this wallet (use --next or --to with a stored public address)."
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
        });
        const plugin = await createProtocolPlugin(protocol, host, chainId);

        if (protocol === "railgun") {
          configureRailgunForUnshield(
            plugin,
            recipientPriv!,
            railgunPimlicoBundlerUrl(chainId)
          );
        }

        if (protocol === "privacy-pools" && "sync" in plugin && typeof plugin.sync === "function") {
          const sync = (plugin as { sync: () => Promise<void> }).sync;
          await runQuietSpinner(
            quiet,
            spin,
            { start: "Syncing private state…", failure: "Sync failed." },
            () => sync.call(plugin),
            () => "Private state synced."
          );
        }

        const isRailgunEth = protocol === "railgun" && tokenMeta.isEth;
        const { cap: maxAmountHint, privacyPoolsLargestNote } =
          await maxUnshieldAmountHint(protocol, plugin, tokenMeta, chainId);
        const maxFormatted = formatUnits(maxAmountHint, tokenMeta.decimals);
        const maxPromptLabel = privacyPoolsLargestNote
          ? "max (largest single note)"
          : "max";
        const maxCapLabel = isRailgunEth
          ? `WETH ${maxPromptLabel}`
          : maxPromptLabel;

        let amount: bigint | null = null;
        if (opts.amountWei) {
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
            : "shielded balance for this token";
          cliError(
            `Amount exceeds ${scope} (${maxFormatted} ${isRailgunEth ? "WETH" : tokenMeta.symbol}).`
          );
          return;
        }

        if (amount === null) {
          const amountInput = await input({
            message: `Amount to unshield (${tokenMeta.symbol}, ${maxCapLabel}: ${maxFormatted}):`,
            validate: (value) => {
              if (!value.trim()) return "Amount is required.";
              try {
                const parsed = parseUnits(value.trim(), tokenMeta.decimals);
                if (parsed <= 0n) return "Amount must be greater than zero.";
                if (maxAmountHint > 0n && parsed > maxAmountHint) {
                  const capSymbol = isRailgunEth ? "WETH" : tokenMeta.symbol;
                  return privacyPoolsLargestNote
                    ? `Exceeds largest note (${maxFormatted} ${capSymbol}); enter that amount or less per withdrawal.`
                    : `Exceeds shielded balance (max ${maxFormatted} ${capSymbol}).`;
                }
              } catch {
                return `Invalid ${tokenMeta.symbol} amount format.`;
              }
              return true;
            },
          });
          amount = parseUnits(amountInput.trim(), tokenMeta.decimals);
        }

        if (amount <= 0n) {
          cliError("Amount must be greater than zero.");
          return;
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

        const prepareLabel =
          protocol === "railgun"
            ? "Building Railgun unshield (proof + broadcaster selection)…"
            : "Building Privacy Pools unshield (proof + relayer quote)…";
        const prepareUnshield = (
          plugin as unknown as {
            prepareUnshield: (
              a: AssetAmount,
              t: `0x${string}`
            ) => Promise<unknown>;
          }
        ).prepareUnshield.bind(plugin);
        const privateOp = await runQuietSpinner(
          quiet,
          spin,
          { start: prepareLabel, failure: "Prepare failed." },
          () => prepareUnshield(asset, recipient),
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
          () => broadcastPreparedPrivateOp(protocol, host, plugin, privateOp),
          () => "Unshield broadcast complete."
        );

        if (persistFreshAccountAfterBroadcast) {
          publicStorage.addNextAccounts(1);
        }

        if (opts.nonInteractive) {
          const amountRaw = amount.toString();
          const amountFormatted = formatUnits(amount, tokenMeta.decimals);
          logCliJson({
            mode: "broadcast" as const,
            protocol,
            recipient,
            token: tokenMeta.symbol,
            amountWei: amountRaw,
            amountFormatted,
            relay: relayResult ?? null,
          });
          return;
        }
        const bundleTxHash = findTxHashDeep(relayResult);
        if (bundleTxHash) {
          console.log(chalk.bold("Etherscan link:"));
          console.log(chalk.cyan(`  ${etherscanTxUrl(chainId, bundleTxHash)}`));
        } else {
          console.log(chalk.dim("Bundler response did not include a tx hash."));
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
