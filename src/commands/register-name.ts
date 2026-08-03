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
  prepareEnsRegister,
  prepareNftRegister,
  prepareSetReverse,
  readNameOwnership,
} from "../lib/names/ops.js";
import {
  generateSecret,
  resolveRegisterSigner,
} from "../lib/names/ownership.js";
import { parseNameProtocol, parseRegisterName } from "../lib/names/parse.js";
import {
  broadcastPreparedTxs,
  etherscanTxUrl,
  maybeConfirm,
  printPreparedTxs,
  simulatePreparedTxs,
  waitUntilCommitmentAged,
} from "../lib/names/tx.js";
import { logCliJson } from "../utils/cli-quiet.js";
import { cliError } from "../utils/cli-errors.js";

type Opts = NameWalletOpts & {
  protocol?: string;
  name?: string;
  years?: string;
  setReverse?: boolean;
};

export function registerRegisterNameCommand(program: Command): void {
  addNameWalletOptions(
    program
      .command("register-name")
      .description(
        "Register a top-level .eth / .gwei / .wei name (commit → 60s wait → reveal/register)"
      )
      .requiredOption("--protocol <ens|gns|wns>", "Naming system to register with")
      .requiredOption(
        "--name <label-or-name>",
        "Bare label (alice) or full name (alice.gwei). TLD must match --protocol when present"
      )
      .option(
        "--index <n>",
        "HD account index that will own the name (default: 0)",
        "0"
      )
      .option(
        "--years <n>",
        "Registration duration in whole years (ENS only; GNS/WNS are always 1 year)",
        "1"
      )
      .option(
        "--set-reverse",
        "Also set this name as the account's primary reverse record (ENS: during register; GNS/WNS: separate setPrimaryName after reveal)"
      )
  ).action(async (opts: Opts) => {
    if (!opts.name?.trim()) {
      cliError("Missing --name.");
      return;
    }

    await withNameCommandContext(opts, async (ctx) => {
      const protocol = parseNameProtocol(opts.protocol);
      const parsed = parseRegisterName(opts.name!, protocol);
      const signer = resolveRegisterSigner({
        walletDir: ctx.walletDir,
        mnemonic: ctx.mnemonic,
        password: ctx.password,
        indexFlag: opts.index,
        ownerPriv: ctx.ownerPriv,
        dryRun: ctx.dryRun,
      });

      const years = Number(opts.years ?? "1");
      const durationSeconds = defaultDurationSeconds(years);
      const secret = generateSecret();
      const setReverse = !!opts.setReverse;

      let commitTx;
      let finishTx;
      let feeWei: bigint;
      let finishStep: string;

      if (protocol === "ens") {
        const prepared = await prepareEnsRegister({
          client: ctx.client,
          parsed,
          owner: signer.address,
          secret,
          durationSeconds,
          reverseRecord: setReverse,
        });
        commitTx = prepared.commit;
        finishTx = prepared.register;
        feeWei = prepared.feeWei;
        finishStep = "register";
      } else {
        if (years !== 1) {
          throw new Error(
            `${protocol.toUpperCase()} registrations are fixed at 1 year; omit --years or pass --years 1.`
          );
        }
        const prepared = await prepareNftRegister({
          client: ctx.client,
          parsed: { ...parsed, protocol },
          owner: signer.address,
          secret,
        });
        commitTx = prepared.commit;
        finishTx = prepared.reveal;
        feeWei = prepared.feeWei;
        finishStep = "reveal";
      }

      if (!ctx.nonInteractive) {
        console.log(
          chalk.dim(
            `Register ${parsed.name} → owner ${signer.address} (index ${signer.index})`
          )
        );
        console.log(chalk.dim(`Registration fee (value): ${formatEther(feeWei)} ETH`));
      }

      if (ctx.dryRun) {
        // Reveal/register cannot be simulated until the commitment exists on-chain.
        await simulatePreparedTxs(ctx.client, signer.address, [commitTx]);
        printPreparedTxs([commitTx, finishTx], signer.address, {
          title: "Planned registration (commit + reveal/register; not submitted)",
        });
        if (ctx.nonInteractive) {
          logCliJson({
            action: "register-name",
            name: parsed.name,
            protocol,
            owner: signer.address,
            index: signer.index,
            feeWei: feeWei.toString(),
            dryRun: true,
            transactions: [commitTx, finishTx].map((t) => ({
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

      await maybeConfirm(
        ctx.nonInteractive,
        `Commit registration for ${parsed.name} from ${signer.address}?`
      );

      const [commitHash] = await broadcastPreparedTxs({
        client: ctx.client,
        rpcUrl: ctx.rpcUrl,
        privateKey: signer.privateKey,
        from: signer.address,
        txs: [commitTx],
        nonInteractive: true, // already confirmed above
      });
      if (!commitHash) {
        throw new Error("Commit transaction failed to return a hash.");
      }

      // Age from the commit *inclusion* block timestamp (not send/receipt wall clock).
      await waitUntilCommitmentAged({
        client: ctx.client,
        commitTxHash: commitHash,
        nonInteractive: ctx.nonInteractive,
      });

      await maybeConfirm(
        ctx.nonInteractive,
        `Submit ${finishStep} for ${parsed.name} (pay ${formatEther(feeWei)} ETH)?`
      );

      const [finishHash] = await broadcastPreparedTxs({
        client: ctx.client,
        rpcUrl: ctx.rpcUrl,
        privateKey: signer.privateKey,
        from: signer.address,
        txs: [finishTx],
        nonInteractive: true,
      });

      // GNS/WNS reverse is a separate call (ENS can set it inside register).
      let reverseHash: `0x${string}` | undefined;
      if (setReverse && protocol !== "ens") {
        const ownership = await readNameOwnership(ctx.client, parsed);
        const reverseTx = prepareSetReverse({ parsed, ownership });
        await maybeConfirm(
          ctx.nonInteractive,
          `Set ${parsed.name} as primary reverse name for ${signer.address}?`
        );
        [reverseHash] = await broadcastPreparedTxs({
          client: ctx.client,
          rpcUrl: ctx.rpcUrl,
          privateKey: signer.privateKey,
          from: signer.address,
          txs: [reverseTx],
          nonInteractive: true,
        });
      }

      const finishUrl = etherscanTxUrl(ctx.chainId, finishHash!);
      const result = {
        action: "register-name",
        name: parsed.name,
        protocol,
        owner: signer.address,
        index: signer.index,
        feeWei: feeWei.toString(),
        commitTx: commitHash,
        finishStep,
        finishTx: finishHash,
        reverseTx: reverseHash,
        urls: {
          commit: etherscanTxUrl(ctx.chainId, commitHash!),
          finish: finishUrl,
          ...(reverseHash
            ? { reverse: etherscanTxUrl(ctx.chainId, reverseHash) }
            : {}),
        },
      };

      if (ctx.nonInteractive) {
        logCliJson(result);
      } else {
        console.log(chalk.green(`Registered ${parsed.name}`));
        console.log(chalk.dim(`commit: ${result.urls.commit}`));
        console.log(chalk.dim(`${finishStep}: ${finishUrl}`));
      }
    });
  });
}
