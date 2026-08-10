import chalk from "chalk";
import type { Command } from "commander";

import {
  addNameWalletOptions,
  withNameCommandContext,
  type NameWalletOpts,
} from "../lib/names/cli.js";
import { prepareSetReverse, readNameOwnership } from "../lib/names/ops.js";
import { resolveNameSigner } from "../lib/names/ownership.js";
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
};

export function registerSetNameReverseRecordCommand(program: Command): void {
  addNameWalletOptions(
    program
      .command("set-name-reverse-record")
      .description(
        "Set a name as the primary reverse record for the signing account (.eth / .gwei / .wei)"
      )
      .requiredOption("--name <name>", "Full name including TLD (e.g. alice.eth)")
      .option(
        "--index <n>",
        "Only needed when the required HD index is not stored in the public accounts list yet"
      )
  ).action(async (opts: Opts) => {
    if (!opts.name?.trim()) {
      cliError("Missing --name.");
      return;
    }

    await withNameCommandContext(opts, async (ctx) => {
      const parsed = parseManagedName(opts.name!);
      const ownership = await readNameOwnership(ctx.client, parsed);

      // ENS reverse is set by the address itself via ReverseRegistrar.
      // GNS/WNS setPrimaryName may be called by the token owner or the resolved address.
      // Default to the NFT/registry owner; --index can select a matching derived key.
      const signer = resolveNameSigner({
        requiredAddress: ownership.owner,
        walletDir: ctx.walletDir,
        mnemonic: ctx.mnemonic,
        password: ctx.password,
        indexFlag: opts.index,
        ownerPriv: ctx.ownerPriv,
        dryRun: ctx.dryRun,
      });

      const tx = prepareSetReverse({ parsed, ownership });

      if (!ctx.nonInteractive) {
        console.log(
          chalk.dim(`Set reverse ${signer.address} → ${parsed.name}`)
        );
      }

      await simulatePreparedTxs(ctx.client, signer.address, [tx]);

      if (ctx.dryRun) {
        printPreparedTxs([tx], signer.address);
        if (ctx.nonInteractive) {
          logCliJson({
            action: "set-name-reverse-record",
            name: parsed.name,
            protocol: parsed.protocol,
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
        confirmMessage: `Set ${parsed.name} as primary name for ${signer.address}?`,
      });

      const result = {
        action: "set-name-reverse-record",
        name: parsed.name,
        protocol: parsed.protocol,
        from: signer.address,
        tx: hash,
        url: etherscanTxUrl(ctx.chainId, hash!),
      };
      if (ctx.nonInteractive) logCliJson(result);
      else console.log(chalk.green(`Set reverse record: ${result.url}`));
    });
  });
}
