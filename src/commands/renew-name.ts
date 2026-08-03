import chalk from "chalk";
import type { Command } from "commander";
import { formatEther } from "viem";

import {
  addNameWalletOptions,
  withNameCommandContext,
  type NameWalletOpts,
} from "../lib/names/cli.js";
import {
  defaultDurationSeconds,
  prepareRenew,
  readNameOwnership,
} from "../lib/names/ops.js";
import { resolveRenewPayer } from "../lib/names/ownership.js";
import { parseManagedName } from "../lib/names/parse.js";
import {
  broadcastPreparedTxs,
  etherscanTxUrl,
  printPreparedTxs,
  simulatePreparedTxs,
} from "../lib/names/tx.js";
import { logCliJson } from "../utils/cli-quiet.js";
import { cliError } from "../utils/cli-errors.js";

type Opts = NameWalletOpts & {
  name?: string;
  years?: string;
};

export function registerRenewNameCommand(program: Command): void {
  addNameWalletOptions(
    program
      .command("renew-name")
      .description("Extend / renew a top-level .eth / .gwei / .wei name")
      .requiredOption("--name <name>", "Full name including TLD (e.g. alice.gwei)")
      .option(
        "--index <n>",
        "HD account index to pay/sign with when not found via name ownership scan"
      )
      .option(
        "--years <n>",
        "Extension duration in whole years (ENS only; GNS/WNS always add 1 year)",
        "1"
      )
  ).action(async (opts: Opts) => {
    if (!opts.name?.trim()) {
      cliError("Missing --name.");
      return;
    }

    await withNameCommandContext(opts, async (ctx) => {
      const parsed = parseManagedName(opts.name!);
      const ownership = await readNameOwnership(ctx.client, parsed);
      // Renewals are not owner-gated on-chain; prefer the NFT owner key when present.
      const payer = resolveRenewPayer({
        ownerAddress: ownership.owner,
        walletDir: ctx.walletDir,
        mnemonic: ctx.mnemonic,
        password: ctx.password,
        indexFlag: opts.index,
        ownerPriv: ctx.ownerPriv,
        dryRun: ctx.dryRun,
      });

      const years = Number(opts.years ?? "1");
      if (parsed.protocol !== "ens" && years !== 1) {
        throw new Error(
          `${parsed.protocol.toUpperCase()} renewals are fixed at +1 year; omit --years or pass --years 1.`
        );
      }
      const durationSeconds = defaultDurationSeconds(years);
      const tx = await prepareRenew({
        client: ctx.client,
        parsed,
        ownership,
        durationSeconds,
      });

      if (!ctx.nonInteractive) {
        console.log(
          chalk.dim(
            `Renew ${parsed.name} from ${payer.address} (pay ${formatEther(tx.value)} ETH)`
          )
        );
      }

      await simulatePreparedTxs(ctx.client, payer.address, [tx]);

      if (ctx.dryRun) {
        printPreparedTxs([tx], payer.address);
        if (ctx.nonInteractive) {
          logCliJson({
            action: "renew-name",
            name: parsed.name,
            protocol: parsed.protocol,
            from: payer.address,
            feeWei: tx.value.toString(),
            dryRun: true,
            transaction: {
              step: tx.step,
              to: tx.to,
              data: tx.data,
              value: tx.value.toString(),
              from: payer.address,
            },
          });
        }
        return;
      }

      if (!payer.privateKey) {
        throw new Error("Missing private key for broadcast. Pass --owner-priv if needed.");
      }

      const [hash] = await broadcastPreparedTxs({
        client: ctx.client,
        rpcUrl: ctx.rpcUrl,
        privateKey: payer.privateKey,
        from: payer.address,
        txs: [tx],
        nonInteractive: ctx.nonInteractive,
        confirmMessage: `Renew ${parsed.name} for ${formatEther(tx.value)} ETH from ${payer.address}?`,
      });

      const result = {
        action: "renew-name",
        name: parsed.name,
        protocol: parsed.protocol,
        from: payer.address,
        feeWei: tx.value.toString(),
        tx: hash,
        url: etherscanTxUrl(ctx.chainId, hash!),
      };
      if (ctx.nonInteractive) logCliJson(result);
      else console.log(chalk.green(`Renewed ${parsed.name}: ${result.url}`));
    });
  });
}
