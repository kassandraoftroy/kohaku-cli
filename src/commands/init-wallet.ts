import chalk from "chalk";
import type { Command } from "commander";
import { createEthereumNames } from "@1001-digital/ethereum-names";
import { formatEther } from "viem";

import {
  addNameWalletOptions,
  withNameCommandContext,
  type NameWalletOpts,
} from "../lib/names/cli.js";
import { MIN_COMMITMENT_AGE_SECONDS } from "../lib/names/constants.js";
import {
  defaultDurationSeconds,
  prepareEnsRegister,
  prepareNftRegister,
  prepareSetReverse,
  prepareSetText,
  readNameOwnership,
} from "../lib/names/ops.js";
import {
  generateSecret,
  resolveNameSigner,
  resolveRegisterSigner,
} from "../lib/names/ownership.js";
import {
  parseManagedName,
  parseNameProtocol,
  parseRegisterName,
} from "../lib/names/parse.js";
import {
  broadcastPreparedTxs,
  etherscanTxUrl,
  maybeConfirm,
  printPreparedTxs,
  simulatePreparedTxs,
  waitUntilCommitmentAged,
} from "../lib/names/tx.js";
import type { NameOwnership } from "../lib/names/types.js";
import { STEALTH_TEXT_RECORD_KEY } from "../lib/stealth/constants.js";
import { deriveStealthKeypair } from "../lib/stealth/keys.js";
import { makeStealthAccountsStorage } from "../lib/stealth/storage.js";
import { logCliJson } from "../utils/cli-quiet.js";
import { cliError } from "../utils/cli-errors.js";

type Opts = NameWalletOpts & {
  protocol?: string;
  name?: string;
  years?: string;
};

/**
 * Bootstrap a wallet identity: ensure a top-level name is owned by this wallet,
 * set reverse + stealth meta-address text record.
 */
export function registerInitWalletCommand(program: Command): void {
  addNameWalletOptions(
    program
      .command("init-wallet")
      .description(
        "Register (or reuse) a .eth/.gwei/.wei name, set reverse, and publish stealth-address-scheme-1"
      )
      .requiredOption(
        "--name <label-or-name>",
        "Bare label or full name (alice / alice.gwei). Existing owned names are reused"
      )
      .option(
        "--protocol <ens|gns|wns>",
        "Required when --name is a bare label (no TLD)"
      )
      .option(
        "--index <n>",
        "HD account index that owns/registers the name (default: 0)",
        "0"
      )
      .option(
        "--years <n>",
        "Registration duration in years when registering a new ENS name (default: 1)",
        "1"
      )
  ).action(async (opts: Opts) => {
    if (!opts.name?.trim()) {
      cliError("Missing --name.");
      return;
    }

    await withNameCommandContext(opts, async (ctx) => {
      const rawName = opts.name!.trim();
      const hasTld = /\.(eth|gwei|wei)$/i.test(rawName);
      const protocol = hasTld
        ? parseManagedName(rawName).protocol
        : parseNameProtocol(opts.protocol);
      if (!hasTld && !opts.protocol) {
        throw new Error(
          "Bare --name requires --protocol <ens|gns|wns> (or pass a full name like alice.gwei)."
        );
      }
      const parsed = hasTld
        ? parseManagedName(rawName)
        : parseRegisterName(rawName, protocol);

      const signer = resolveRegisterSigner({
        walletDir: ctx.walletDir,
        mnemonic: ctx.mnemonic,
        password: ctx.password,
        indexFlag: opts.index ?? "0",
        ownerPriv: ctx.ownerPriv,
        dryRun: ctx.dryRun,
      });

      const keypair = deriveStealthKeypair(ctx.mnemonic, ctx.chainId);
      const stealthStorage = makeStealthAccountsStorage(
        ctx.walletDir,
        ctx.password
      );

      let ownership: NameOwnership | undefined;
      let needsRegister = false;
      try {
        ownership = await readNameOwnership(ctx.client, parsed);
        const ownedBySigner =
          ownership.owner.toLowerCase() === signer.address.toLowerCase() ||
          ownership.manager.toLowerCase() === signer.address.toLowerCase();
        if (!ownedBySigner) {
          throw new Error(
            `Name ${parsed.name} is owned by ${ownership.owner}, not wallet index ${signer.index} (${signer.address}).`
          );
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/is owned by/i.test(msg)) throw e;
        needsRegister = true;
      }

      const hashes: string[] = [];

      if (needsRegister) {
        const secret = generateSecret();
        const years = Number(opts.years ?? "1");
        const durationSeconds = defaultDurationSeconds(years);
        let commitTx;
        let finishTx;
        let feeWei: bigint;
        let finishStep: string;

        if (parsed.protocol === "ens") {
          const prepared = await prepareEnsRegister({
            client: ctx.client,
            parsed,
            owner: signer.address,
            secret,
            durationSeconds,
            reverseRecord: true,
          });
          commitTx = prepared.commit;
          finishTx = prepared.register;
          feeWei = prepared.feeWei;
          finishStep = "register";
        } else {
          if (years !== 1) {
            throw new Error(
              `${parsed.protocol.toUpperCase()} registrations are fixed at 1 year.`
            );
          }
          const prepared = await prepareNftRegister({
            client: ctx.client,
            parsed: { ...parsed, protocol: parsed.protocol },
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
              `Register ${parsed.name} → ${signer.address} (fee ${formatEther(feeWei)} ETH)`
            )
          );
        }

        if (ctx.dryRun) {
          await simulatePreparedTxs(ctx.client, signer.address, [commitTx]);
          printPreparedTxs([commitTx, finishTx], signer.address, {
            title: "init-wallet registration (not submitted)",
          });
        } else {
          if (!signer.privateKey) {
            throw new Error("Missing private key. Pass --owner-priv if needed.");
          }
          await maybeConfirm(
            ctx.nonInteractive,
            `Commit registration for ${parsed.name}?`
          );
          const [commitHash] = await broadcastPreparedTxs({
            client: ctx.client,
            rpcUrl: ctx.rpcUrl,
            privateKey: signer.privateKey,
            from: signer.address,
            txs: [commitTx],
            nonInteractive: true,
          });
          hashes.push(commitHash!);
          await waitUntilCommitmentAged({
            client: ctx.client,
            commitTxHash: commitHash!,
            minAgeSeconds: MIN_COMMITMENT_AGE_SECONDS,
            nonInteractive: ctx.nonInteractive,
          });
          await maybeConfirm(
            ctx.nonInteractive,
            `Submit ${finishStep} for ${parsed.name}?`
          );
          const [finishHash] = await broadcastPreparedTxs({
            client: ctx.client,
            rpcUrl: ctx.rpcUrl,
            privateKey: signer.privateKey,
            from: signer.address,
            txs: [finishTx],
            nonInteractive: true,
          });
          hashes.push(finishHash!);
        }
        ownership = await readNameOwnership(ctx.client, parsed).catch(() => ownership);
      } else if (!ctx.nonInteractive) {
        console.log(chalk.dim(`Reusing owned name ${parsed.name}`));
      }

      // Ensure we sign as the on-chain owner/manager for record updates.
      if (!ownership) {
        if (ctx.dryRun && needsRegister) {
          if (ctx.nonInteractive) {
            logCliJson({
              action: "init-wallet",
              name: parsed.name,
              protocol: parsed.protocol,
              owner: signer.address,
              stealthMetaAddressURI: keypair.stealthMetaAddressURI,
              dryRun: true,
              note: "Registration payloads printed above; record updates require --broadcast after commit/reveal.",
            });
          } else {
            console.log(
              chalk.dim(
                "Dry-run: register payloads printed. Re-run with --broadcast to register and set stealth text/reverse."
              )
            );
            console.log(
              chalk.dim(`Would publish ${STEALTH_TEXT_RECORD_KEY}=${keypair.stealthMetaAddressURI}`)
            );
          }
          return;
        }
        ownership = await readNameOwnership(ctx.client, parsed);
      }

      const recordSigner = resolveNameSigner({
        requiredAddress: ownership.manager,
        walletDir: ctx.walletDir,
        mnemonic: ctx.mnemonic,
        password: ctx.password,
        indexFlag: opts.index,
        ownerPriv: ctx.ownerPriv,
        dryRun: ctx.dryRun,
      });

      const reverseTx =
        parsed.protocol === "ens" && needsRegister
          ? null // ENS register already set reverseRecord: true
          : prepareSetReverse({ parsed, ownership });

      const textTx = await prepareSetText({
        client: ctx.client,
        parsed,
        ownership,
        key: STEALTH_TEXT_RECORD_KEY,
        value: keypair.stealthMetaAddressURI,
      });

      const recordTxs = [...(reverseTx ? [reverseTx] : []), textTx];

      if (ctx.dryRun) {
        if (!needsRegister) {
          await simulatePreparedTxs(ctx.client, recordSigner.address, recordTxs);
        }
        printPreparedTxs(recordTxs, recordSigner.address, {
          title: "init-wallet record updates (not submitted)",
        });
        if (ctx.nonInteractive) {
          logCliJson({
            action: "init-wallet",
            name: parsed.name,
            protocol: parsed.protocol,
            owner: signer.address,
            stealthMetaAddressURI: keypair.stealthMetaAddressURI,
            dryRun: true,
          });
        }
        return;
      }

      if (!recordSigner.privateKey) {
        throw new Error("Missing private key for record updates.");
      }

      if (reverseTx) {
        await maybeConfirm(
          ctx.nonInteractive,
          `Set reverse record ${parsed.name} for ${recordSigner.address}?`
        );
        const [h] = await broadcastPreparedTxs({
          client: ctx.client,
          rpcUrl: ctx.rpcUrl,
          privateKey: recordSigner.privateKey,
          from: recordSigner.address,
          txs: [reverseTx],
          nonInteractive: true,
        });
        hashes.push(h!);
      }

      await maybeConfirm(
        ctx.nonInteractive,
        `Set ${STEALTH_TEXT_RECORD_KEY} on ${parsed.name}?`
      );
      const [textHash] = await broadcastPreparedTxs({
        client: ctx.client,
        rpcUrl: ctx.rpcUrl,
        privateKey: recordSigner.privateKey,
        from: recordSigner.address,
        txs: [textTx],
        nonInteractive: true,
      });
      hashes.push(textHash!);

      stealthStorage.setMeta({
        metaAddressURI: keypair.stealthMetaAddressURI,
        name: parsed.name,
      });

      // Verify text record when possible.
      try {
        const names = createEthereumNames({ rpcUrl: ctx.rpcUrl });
        const published = await names.getText(
          parsed.name,
          STEALTH_TEXT_RECORD_KEY
        );
        if (
          published &&
          published.toLowerCase() !== keypair.stealthMetaAddressURI.toLowerCase()
        ) {
          console.log(
            chalk.yellow(
              `Warning: on-chain text record differs from expected meta URI.`
            )
          );
        }
      } catch {
        // ignore verify failures
      }

      const result = {
        action: "init-wallet",
        name: parsed.name,
        protocol: parsed.protocol,
        owner: signer.address,
        index: signer.index,
        stealthMetaAddressURI: keypair.stealthMetaAddressURI,
        txs: hashes,
        urls: hashes.map((h) => etherscanTxUrl(ctx.chainId, h)),
      };
      if (ctx.nonInteractive) logCliJson(result);
      else {
        console.log(chalk.green(`Initialized wallet identity ${parsed.name}`));
        console.log(chalk.dim(`stealth meta: ${keypair.stealthMetaAddressURI}`));
        for (const url of result.urls) console.log(chalk.dim(url));
      }
    });
  });
}
