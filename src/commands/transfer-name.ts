import { input, select } from "@inquirer/prompts";
import chalk from "chalk";
import type { Command } from "commander";
import { isAddress } from "viem";

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
import { looksLikeName, resolveAddressOrName } from "../utils/resolve-name.js";

type Opts = NameWalletOpts & {
  name?: string;
  to?: string;
  role?: string;
};

type TransferRole = "owner" | "manager" | "both";

async function resolveRecipient(opts: {
  to?: string;
  nonInteractive: boolean;
}): Promise<string> {
  if (opts.to?.trim()) {
    return opts.to.trim();
  }
  if (opts.nonInteractive) {
    throw new Error("Missing --to (required with --non-interactive).");
  }
  const raw = await input({
    message: "Recipient address or name (.eth / .gwei / .wei)",
    validate: (value) => {
      const v = value.trim();
      if (!v) return "Recipient is required.";
      if (!isAddress(v) && !looksLikeName(v)) {
        return "Enter a valid Ethereum address or a name ending in .eth, .gwei, or .wei.";
      }
      return true;
    },
  });
  return raw.trim();
}

async function resolveRole(opts: {
  roleFlag?: string;
  protocol: "ens" | "gns" | "wns";
  nonInteractive: boolean;
}): Promise<TransferRole> {
  if (opts.roleFlag !== undefined && opts.roleFlag !== "") {
    return parseTransferRole(opts.roleFlag);
  }

  if (opts.nonInteractive) {
    return "both";
  }

  if (opts.protocol !== "ens") {
    // GNS/WNS only transfer the NFT owner; skip a confusing multi-role prompt.
    return "owner";
  }

  return await select<TransferRole>({
    message: "What to transfer",
    default: "both",
    choices: [
      { name: "both (owner + manager)", value: "both" },
      { name: "owner", value: "owner" },
      { name: "manager", value: "manager" },
    ],
  });
}

export function registerTransferNameCommand(program: Command): void {
  addNameWalletOptions(
    program
      .command("transfer-name")
      .description(
        "Transfer name ownership and/or ENS manager. GNS/WNS only support NFT owner transfer."
      )
      .requiredOption("--name <name>", "Full name including TLD (e.g. alice.eth)")
      .option(
        "--to <address-or-name>",
        "Recipient address or .eth/.gwei/.wei name; prompted if omitted"
      )
      .option(
        "--role <owner|manager|both>",
        "What to transfer (default: both). manager/both are ENS-only; prompted if omitted"
      )
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
      let toRaw: string;
      try {
        toRaw = await resolveRecipient({
          to: opts.to,
          nonInteractive: ctx.nonInteractive,
        });
      } catch (e) {
        cliError(e instanceof Error ? e.message : String(e));
        return;
      }

      const parsed = parseManagedName(opts.name!);
      let role: TransferRole;
      try {
        role = await resolveRole({
          roleFlag: opts.role,
          protocol: parsed.protocol,
          nonInteractive: ctx.nonInteractive,
        });
      } catch (e) {
        cliError(e instanceof Error ? e.message : String(e));
        return;
      }

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

      const to = await resolveToAddress(toRaw, (v) =>
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
