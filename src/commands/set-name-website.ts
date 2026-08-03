import chalk from "chalk";
import type { Command } from "commander";

import {
  addNameWalletOptions,
  withNameCommandContext,
  type NameWalletOpts,
} from "../lib/names/cli.js";
import { encodeWebsiteContenthash } from "../lib/names/contenthash.js";
import { prepareSetWebsite, readNameOwnership } from "../lib/names/ops.js";
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
  contentHash?: string;
};

export function registerSetNameWebsiteCommand(program: Command): void {
  addNameWalletOptions(
    program
      .command("set-name-website")
      .description(
        "Set the contenthash / website for a top-level .eth / .gwei / .wei name"
      )
      .requiredOption("--name <name>", "Full name including TLD (e.g. alice.gwei)")
      .requiredOption(
        "--content-hash <uri>",
        "Website contenthash URI (must start with ipfs:// or bzz://)"
      )
      .option(
        "--index <n>",
        "HD account index when the name manager/owner is not in public accounts"
      )
  ).action(async (opts: Opts) => {
    if (!opts.name?.trim()) {
      cliError("Missing --name.");
      return;
    }
    if (!opts.contentHash?.trim()) {
      cliError("Missing --content-hash.");
      return;
    }

    await withNameCommandContext(opts, async (ctx) => {
      const parsed = parseManagedName(opts.name!);
      const contenthash = encodeWebsiteContenthash(opts.contentHash!);
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

      const tx = await prepareSetWebsite({ parsed, ownership, contenthash, client: ctx.client });

      if (!ctx.nonInteractive) {
        console.log(
          chalk.dim(`Set website ${opts.contentHash} on ${parsed.name}`)
        );
      }

      await simulatePreparedTxs(ctx.client, signer.address, [tx]);

      if (ctx.dryRun) {
        printPreparedTxs([tx], signer.address);
        if (ctx.nonInteractive) {
          logCliJson({
            action: "set-name-website",
            name: parsed.name,
            protocol: parsed.protocol,
            contentHash: opts.contentHash,
            encoded: contenthash,
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
        confirmMessage: `Set website on ${parsed.name} from ${signer.address}?`,
      });

      const result = {
        action: "set-name-website",
        name: parsed.name,
        protocol: parsed.protocol,
        contentHash: opts.contentHash,
        encoded: contenthash,
        from: signer.address,
        tx: hash,
        url: etherscanTxUrl(ctx.chainId, hash!),
      };
      if (ctx.nonInteractive) logCliJson(result);
      else console.log(chalk.green(`Updated website: ${result.url}`));
    });
  });
}
