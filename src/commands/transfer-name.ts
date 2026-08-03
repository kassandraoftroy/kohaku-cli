import chalk from "chalk";
import type { Command } from "commander";

import {
  addNameWalletOptions,
  withNameCommandContext,
  type NameWalletOpts,
} from "../lib/names/cli.js";
import { prepareTransfer, readNameOwnership } from "../lib/names/ops.js";
import {
  parseTransferRole,
  requiredAddressForTransfer,
  resolveNameSigner,
  resolveToAddress,
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
import { resolveAddressOrName } from "../utils/resolve-name.js";

type Opts = NameWalletOpts & {
  name?: string;
  to?: string;
  role?: string;
};

export function registerTransferNameCommand(program: Command): void {
  addNameWalletOptions(
    program
      .command("transfer-name")
      .description(
        "Transfer name ownership and/or ENS manager. GNS/WNS only support NFT owner transfer."
      )
      .requiredOption("--name <name>", "Full name including TLD (e.g. alice.eth)")
      .requiredOption("--to <address-or-name>", "Recipient address or .eth/.gwei/.wei name")
      .option(
        "--role <owner|manager|both>",
        "What to transfer (default: owner). manager/both are ENS-only",
        "owner"
      )
      .option(
        "--index <n>",
        "HD account index when the required controller is not in public accounts"
      )
  ).action(async (opts: Opts) => {
    if (!opts.name?.trim()) {
      cliError("Missing --name.");
      return;
    }
    if (!opts.to?.trim()) {
      cliError("Missing --to.");
      return;
    }

    await withNameCommandContext(opts, async (ctx) => {
      const parsed = parseManagedName(opts.name!);
      const role = parseTransferRole(opts.role);
      const ownership = await readNameOwnership(ctx.client, parsed);
      const required = requiredAddressForTransfer(ownership, role);
      const signer = resolveNameSigner({
        requiredAddress: required,
        walletDir: ctx.walletDir,
        mnemonic: ctx.mnemonic,
        password: ctx.password,
        indexFlag: opts.index,
        ownerPriv: ctx.ownerPriv,
        dryRun: ctx.dryRun,
      });

      const to = await resolveToAddress(opts.to!, (v) =>
        resolveAddressOrName(v, ctx.rpcUrl)
      );

      const txs = prepareTransfer({
        parsed,
        ownership,
        from: signer.address,
        to,
        role,
      });

      if (!ctx.nonInteractive) {
        console.log(
          chalk.dim(
            `Transfer ${parsed.name} (${role}) ${signer.address} → ${to}`
          )
        );
      }

      await simulatePreparedTxs(ctx.client, signer.address, txs);

      if (ctx.dryRun) {
        printPreparedTxs(txs, signer.address);
        if (ctx.nonInteractive) {
          logCliJson({
            action: "transfer-name",
            name: parsed.name,
            protocol: parsed.protocol,
            role,
            from: signer.address,
            to,
            dryRun: true,
            transactions: txs.map((t) => ({
              step: t.step,
              to: t.to,
              data: t.data,
              value: t.value.toString(),
              from: signer.address,
            })),
          });
        }
        return;
      }

      if (!signer.privateKey) {
        throw new Error("Missing private key for broadcast. Pass --owner-priv if needed.");
      }

      const hashes = await broadcastPreparedTxs({
        client: ctx.client,
        rpcUrl: ctx.rpcUrl,
        privateKey: signer.privateKey,
        from: signer.address,
        txs,
        nonInteractive: ctx.nonInteractive,
        confirmMessage: `Transfer ${parsed.name} (${role}) to ${to} from ${signer.address}?`,
      });

      const result = {
        action: "transfer-name",
        name: parsed.name,
        protocol: parsed.protocol,
        role,
        from: signer.address,
        to,
        txs: hashes,
        urls: hashes.map((h) => etherscanTxUrl(ctx.chainId, h)),
      };
      if (ctx.nonInteractive) logCliJson(result);
      else {
        console.log(chalk.green(`Transferred ${parsed.name}`));
        for (const url of result.urls) console.log(chalk.dim(url));
      }
    });
  });
}
