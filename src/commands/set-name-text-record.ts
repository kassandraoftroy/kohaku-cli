import chalk from "chalk";
import type { Command } from "commander";

import {
  addNameWalletOptions,
  withNameCommandContext,
  type NameWalletOpts,
} from "../lib/names/cli.js";
import { prepareSetText, readNameOwnership } from "../lib/names/ops.js";
import {
  requiredAddressForRecords,
  resolveNameSigner,
} from "../lib/names/ownership.js";
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
  key?: string;
  value?: string;
};

export function registerSetNameTextRecordCommand(program: Command): void {
  addNameWalletOptions(
    program
      .command("set-name-text-record")
      .description("Set a text record on a top-level .eth / .gwei / .wei name")
      .requiredOption("--name <name>", "Full name including TLD (e.g. alice.wei)")
      .requiredOption("--key <key>", "Text record key (e.g. url, avatar, com.twitter)")
      .requiredOption("--value <value>", "Text record value (empty string clears)")
      .option(
        "--index <n>",
        "HD account index when the name manager/owner is not in public accounts"
      )
  ).action(async (opts: Opts) => {
    if (!opts.name?.trim()) {
      cliError("Missing --name.");
      return;
    }
    if (opts.key === undefined) {
      cliError("Missing --key.");
      return;
    }
    if (opts.value === undefined) {
      cliError("Missing --value.");
      return;
    }

    await withNameCommandContext(opts, async (ctx) => {
      const parsed = parseManagedName(opts.name!);
      const ownership = await readNameOwnership(ctx.client, parsed);
      const signer = resolveNameSigner({
        requiredAddress: requiredAddressForRecords(ownership),
        walletDir: ctx.walletDir,
        mnemonic: ctx.mnemonic,
        password: ctx.password,
        indexFlag: opts.index,
        ownerPriv: ctx.ownerPriv,
        dryRun: ctx.dryRun,
      });

      const tx = await prepareSetText({
        client: ctx.client,
        parsed,
        ownership,
        key: opts.key!,
        value: opts.value!,
      });

      if (!ctx.nonInteractive) {
        console.log(
          chalk.dim(
            `Set text ${opts.key}=${JSON.stringify(opts.value)} on ${parsed.name}`
          )
        );
      }

      await simulatePreparedTxs(ctx.client, signer.address, [tx]);

      if (ctx.dryRun) {
        printPreparedTxs([tx], signer.address);
        if (ctx.nonInteractive) {
          logCliJson({
            action: "set-name-text-record",
            name: parsed.name,
            protocol: parsed.protocol,
            key: opts.key,
            value: opts.value,
            from: signer.address,
            dryRun: true,
            transaction: {
              step: tx.step,
              to: tx.to,
              data: tx.data,
              value: tx.value.toString(),
              from: signer.address,
            },
          });
        }
        return;
      }

      if (!signer.privateKey) {
        throw new Error("Missing private key for broadcast. Pass --owner-priv if needed.");
      }

      const [hash] = await broadcastPreparedTxs({
        client: ctx.client,
        rpcUrl: ctx.rpcUrl,
        privateKey: signer.privateKey,
        from: signer.address,
        txs: [tx],
        nonInteractive: ctx.nonInteractive,
        confirmMessage: `Set text record ${opts.key} on ${parsed.name} from ${signer.address}?`,
      });

      const result = {
        action: "set-name-text-record",
        name: parsed.name,
        protocol: parsed.protocol,
        key: opts.key,
        value: opts.value,
        from: signer.address,
        tx: hash,
        url: etherscanTxUrl(ctx.chainId, hash!),
      };
      if (ctx.nonInteractive) logCliJson(result);
      else console.log(chalk.green(`Updated text record: ${result.url}`));
    });
  });
}
