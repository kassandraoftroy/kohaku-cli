import { input } from "@inquirer/prompts";
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

async function resolveRenewYears(opts: {
  protocol: "ens" | "gns" | "wns";
  yearsFlag?: string;
  nonInteractive: boolean;
}): Promise<number> {
  if (opts.protocol !== "ens") {
    if (opts.yearsFlag !== undefined && opts.yearsFlag !== "" && Number(opts.yearsFlag) !== 1) {
      throw new Error(
        `${opts.protocol.toUpperCase()} renewals are fixed at +1 year; omit --years or pass --years 1.`
      );
    }
    return 1;
  }

  if (opts.yearsFlag !== undefined && opts.yearsFlag !== "") {
    const years = Number(opts.yearsFlag);
    if (!Number.isInteger(years) || years < 1) {
      throw new Error("--years must be a positive integer.");
    }
    return years;
  }

  if (opts.nonInteractive) {
    return 1;
  }

  const raw = await input({
    message: "Renewal duration in years",
    default: "1",
    validate: (value) => {
      const n = Number(value.trim());
      if (!Number.isInteger(n) || n < 1) {
        return "Enter a positive whole number of years.";
      }
      return true;
    },
  });
  return Number(raw.trim());
}

export function registerRenewNameCommand(program: Command): void {
  addNameWalletOptions(
    program
      .command("renew-name")
      .description("Extend / renew a top-level .eth / .gwei / .wei name")
      .requiredOption("--name <name>", "Full name including TLD (e.g. alice.gwei)")
      .option(
        "--index <n>",
        "Only needed when the payer HD index is not stored in the public accounts list yet (defaults to name owner when present)"
      )
      .option(
        "--years <n>",
        "Extension duration in whole years (ENS only; GNS/WNS always add 1 year). Interactive default: 1"
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

      const years = await resolveRenewYears({
        protocol: parsed.protocol,
        yearsFlag: opts.years,
        nonInteractive: ctx.nonInteractive,
      });
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
            `Renew ${parsed.name} (+${years} year${years === 1 ? "" : "s"}) from ${payer.address} (pay ${formatEther(tx.value)} ETH)`
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
            years,
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
        years,
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
