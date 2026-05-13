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
  resolveRpcUrl,
} from "../utils/rpc";
import { resolveTokenMeta } from "../utils/tokens-util";
import {
  resolveWalletDir,
  resolveWalletNameOrPrompt,
  resolveWalletPassword,
} from "../utils/wallets-util";
import { readSeedKeystore } from "../utils/mnemonic";
import { makePublicAccountsStorage } from "../utils/public-accounts";
import {
  ETH_AS_ERC20,
  PRIVACY_POOLS_BROADCASTER_URL,
  assertPpErc20TokenWhitelisted,
  createProtocolPlugin,
  isSupportedProtocol,
  pluginIdForProtocol,
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
    .option("--next", "Unshield to the next fresh public account (addNextAccounts(1))")
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

      let recipient: `0x${string}`;
      if (hasNext) {
        const added = publicStorage.addNextAccounts(1);
        recipient = getAddress(added[0]!.address) as `0x${string}`;
      } else if (hasTo) {
        const raw = opts.to!.trim();
        if (!isAddress(raw)) {
          cliError(`Invalid --to address: ${raw}`);
          return;
        }
        recipient = getAddress(raw) as `0x${string}`;
      } else {
        const existingAccounts = publicStorage.getAccounts();
        const NEXT_FRESH = "__next_fresh__";
        const CUSTOM_ADDR = "__custom__";

        const choices: Array<{ value: string; name: string }> = [];
        choices.push({
          value: NEXT_FRESH,
          name: "Generate next fresh public account (--next)",
        });
        choices.push({
          value: CUSTOM_ADDR,
          name: "Enter a custom address",
        });
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
          const added = publicStorage.addNextAccounts(1);
          recipient = getAddress(added[0]!.address) as `0x${string}`;
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
        }
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

        let shieldedBalance = 0n;
        try {
          const balances: AssetAmount[] = await (
            plugin as unknown as { balance: (a: unknown) => Promise<AssetAmount[]> }
          ).balance(undefined);
          const targetAddr = tokenMeta.isEth
            ? ETH_AS_ERC20.toLowerCase()
            : tokenMeta.tokenAddress.toLowerCase();
          for (const row of balances) {
            const asset = row.asset as { __type?: string; contract?: unknown } | undefined;
            if (!asset || asset.__type !== "erc20") continue;
            let addr: string;
            if (typeof asset.contract === "string") addr = asset.contract.toLowerCase();
            else if (typeof asset.contract === "bigint")
              addr = `0x${asset.contract.toString(16).padStart(40, "0")}`;
            else continue;
            if (addr === targetAddr) {
              shieldedBalance += row.amount;
            }
          }
        } catch {
          // balance query may fail for some protocols; proceed without max hint
        }

        const maxFormatted = formatUnits(shieldedBalance, tokenMeta.decimals);

        let amount: bigint | null = null;
        if (opts.amountWei) {
          amount = BigInt(opts.amountWei);
        } else if (opts.amountFormatted) {
          amount = parseUnits(opts.amountFormatted, tokenMeta.decimals);
        }

        if (amount === null) {
          const amountInput = await input({
            message: `Amount to unshield (${tokenMeta.symbol}, max: ${maxFormatted}):`,
            validate: (value) => {
              if (!value.trim()) return "Amount is required.";
              try {
                const parsed = parseUnits(value.trim(), tokenMeta.decimals);
                if (parsed <= 0n) return "Amount must be greater than zero.";
                if (shieldedBalance > 0n && parsed > shieldedBalance)
                  return `Exceeds shielded balance (max ${maxFormatted} ${tokenMeta.symbol}).`;
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

        const asset: AssetAmount = {
          asset: {
            __type: "erc20",
            contract: tokenMeta.tokenAddress as `0x${string}`,
          },
          amount,
        };

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

        const amountLabel = `${formatUnits(amount, tokenMeta.decimals)} ${tokenMeta.symbol}`;
        const via =
          protocol === "railgun"
            ? "Railgun (Waku broadcaster)"
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
          { start: "Broadcasting unshield…", failure: "Broadcast failed." },
          () => broadcastPreparedPrivateOp(protocol, host, plugin, privateOp),
          () => "Unshield broadcast complete."
        );

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
