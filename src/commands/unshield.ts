import { confirm } from "@inquirer/prompts";
import { createPPv1Broadcaster } from "@kohaku-eth/privacy-pools";
import { log, spinner } from "@clack/prompts";
import chalk from "chalk";
import type { AssetAmount, Host } from "@kohaku-eth/plugins";
import type { Command } from "commander";
import { formatUnits, getAddress, isAddress, parseUnits } from "ethers";

import { makeHost } from "../host/makeHost";
import { cliOptions } from "../utils/cli-command-options";
import { cliError, cliErrorFromCaught } from "../utils/cli-errors";
import { jsonStringifyWithBigInt } from "../utils/json-bigint";
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
): Promise<void> {
  if (protocol === "railgun") {
    await (plugin as { broadcast: (op: unknown) => Promise<void> }).broadcast(
      operation
    );
    return;
  }
  const broadcaster = createPPv1Broadcaster(host, {
    broadcasterUrl: PRIVACY_POOLS_BROADCASTER_URL,
  });
  await broadcaster.broadcast(operation as never);
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
      if (hasTo === hasNext) {
        cliError("Provide exactly one of --to <address> or --next.");
        return;
      }

      if (!!opts.amountWei === !!opts.amountFormatted) {
        cliError("Provide exactly one of --amount-wei or --amount-formatted.");
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

      let recipient: `0x${string}`;
      if (hasNext) {
        const storage = makePublicAccountsStorage(walletDir, mnemonic, password);
        const added = storage.addNextAccounts(1);
        recipient = getAddress(added[0]!.address) as `0x${string}`;
      } else {
        const raw = opts.to!.trim();
        if (!isAddress(raw)) {
          cliError(`Invalid --to address: ${raw}`);
          return;
        }
        recipient = getAddress(raw) as `0x${string}`;
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

      const amount = opts.amountWei
        ? BigInt(opts.amountWei)
        : parseUnits(opts.amountFormatted ?? "0", tokenMeta.decimals);
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

      const rpcForHost = await makeEthersProvider(rpcUrl);
      const spin = spinner();
      try {
        const host = await makeHost({
          rpc: rpcForHost,
          walletDir,
          password,
          mnemonic,
          pluginId: pluginIdForProtocol(protocol),
        });
        const plugin = await createProtocolPlugin(protocol, host, chainId);

        if (!opts.nonInteractive) {
          console.log(
            chalk.yellow(
              "Unshielding sends a private withdrawal through the protocol relayer/broadcaster. Review the amount and recipient carefully."
            )
          );
        }

        if (protocol === "privacy-pools" && "sync" in plugin && typeof plugin.sync === "function") {
          spin.start("Syncing private state…");
          try {
            await plugin.sync();
            spin.stop("Private state synced.");
          } catch (syncErr) {
            spin.stop("Sync failed.");
            throw syncErr;
          }
        }

        const prepareLabel =
          protocol === "railgun"
            ? "Building Railgun unshield (proof + broadcaster selection)…"
            : "Building Privacy Pools unshield (proof + relayer quote)…";
        spin.start(prepareLabel);
        let privateOp: unknown;
        try {
          const prepareUnshield = (
            plugin as unknown as {
              prepareUnshield: (
                a: AssetAmount,
                t: `0x${string}`
              ) => Promise<unknown>;
            }
          ).prepareUnshield.bind(plugin);
          privateOp = await prepareUnshield(asset, recipient);
          spin.stop("Unshield operation prepared.");
        } catch (prepErr) {
          spin.stop("Prepare failed.");
          throw prepErr;
        }

        const amountLabel = `${formatUnits(amount, tokenMeta.decimals)} ${tokenMeta.symbol}`;
        const via =
          protocol === "railgun"
            ? "Railgun (Waku broadcaster)"
            : "Privacy Pools relayer";

        if (!opts.broadcast) {
          const payload = { privateOperation: privateOp };
          if (opts.nonInteractive) {
            console.log(jsonStringifyWithBigInt(payload));
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
            console.log(jsonStringifyWithBigInt(payload, 2));
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

        spin.start("Broadcasting unshield…");
        try {
          await broadcastPreparedPrivateOp(
            protocol,
            host,
            plugin,
            privateOp
          );
          spin.stop("Unshield broadcast complete.");
        } catch (bcErr) {
          spin.stop("Broadcast failed.");
          throw bcErr;
        }
      } catch (e) {
        cliErrorFromCaught(e);
        return;
      } finally {
        rpcForHost.destroy();
      }

      console.log(chalk.green("✔ Unshield flow completed."));
    });
}
