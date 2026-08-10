import chalk from "chalk";
import type { Command } from "commander";
import { createEthereumNames } from "@1001-digital/ethereum-names";
import { formatEther, namehash, type Address, type Hex } from "viem";

import {
  addNameWalletOptions,
  withNameCommandContext,
  type NameWalletOpts,
} from "../lib/names/cli.js";
import { MIN_COMMITMENT_AGE_SECONDS } from "../lib/names/constants.js";
import {
  defaultDurationSeconds,
  nftContract,
  prepareEnsPublicResolverSetText,
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
import { makePublicAccountsStorage } from "../utils/public-accounts.js";
import { parseFromIndex } from "../lib/shield-flow.js";
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
import type { NameOwnership, PreparedTx } from "../lib/names/types.js";
import { STEALTH_TEXT_RECORD_KEY } from "eth-stealth-address-resolver";
import { deriveStealthKeypair } from "../lib/stealth/keys.js";
import {
  needsStealthRegistryUpdate,
  prepareRegisterStealthKeys,
} from "../lib/stealth/registry.js";
import { makeStealthAccountsStorage } from "../lib/stealth/storage.js";
import { logCliJson } from "../utils/cli-quiet.js";
import { cliError } from "../utils/cli-errors.js";
import {
  estimateEip7702BatchUserOpFee,
  needsSimple7702Authorization,
  sendEip7702BatchUserOperation,
  type Eip7702BatchCall,
} from "../utils/eip7702-batch-userop.js";
import {
  estimateEoaTxFeePreview,
  feeConfirmLine,
  printFeePreview,
} from "../utils/fee-preview.js";
import { NAME_NFT_ABI } from "../lib/names/abis.js";
import { SIMPLE_7702_IMPLEMENTATION } from "../utils/simple-7702.js";

type Opts = NameWalletOpts & {
  protocol?: string;
  name?: string;
  noName?: boolean;
  years?: string;
};

function toBatchCall(t: PreparedTx): Eip7702BatchCall {
  return { to: t.to, data: t.data, value: t.value };
}

function summarizeSteps(txs: PreparedTx[]): string {
  return txs.map((t) => t.step).join(" + ");
}

/** Predicted GNS/WNS ownership before reveal (token id is deterministic). */
async function predictNftOwnership(opts: {
  client: Parameters<typeof readNameOwnership>[0];
  parsed: { name: string; protocol: "gns" | "wns" };
  owner: Address;
}): Promise<NameOwnership> {
  const contract = nftContract(opts.parsed.protocol);
  const tokenId = await opts.client.readContract({
    address: contract,
    abi: NAME_NFT_ABI,
    functionName: "computeId",
    args: [opts.parsed.name],
  });
  return {
    owner: opts.owner,
    manager: opts.owner,
    wrapped: false,
    node: `0x${tokenId.toString(16).padStart(64, "0")}` as Hex,
    tokenId,
  };
}

function predictEnsOwnership(opts: {
  parsed: { name: string };
  owner: Address;
}): NameOwnership {
  return {
    owner: opts.owner,
    manager: opts.owner,
    wrapped: false,
    node: namehash(opts.parsed.name) as Hex,
  };
}

/**
 * Bootstrap wallet stealth identity: optionally register a name + text/reverse,
 * always publish scheme-1 keys on the ERC-6538 registry for the chosen index.
 *
 * With a new name: commit (EOA) → wait 60s → one EIP-7702 UserOp for
 * reveal/register + reverse + text + registerKeys.
 * With `--no-name`: a single `registerKeys` EOA tx (no 7702).
 */
export function registerInitProfileCommand(program: Command): void {
  addNameWalletOptions(
    program
      .command("init-profile")
      .description(
        "Publish profile stealth keys on ERC-6538; optionally register a .eth/.gwei/.wei name + stealth-address-scheme-1 (post-commit steps batched via EIP-7702)"
      )
      .option(
        "--name <label-or-name>",
        "Bare label or full name (alice / alice.gwei). Existing owned names are reused"
      )
      .option(
        "--no-name",
        "Skip name registration; only register stealth keys for --index on ERC-6538"
      )
      .option(
        "--protocol <ens|gns|wns>",
        "Required when --name is a bare label (no TLD)"
      )
      .option(
        "--index <n>",
        "HD account index that owns/registers the name and registry entry (default: 0)",
        "0"
      )
      .option(
        "--years <n>",
        "Registration duration in years when registering a new ENS name (default: 1)",
        "1"
      )
  ).action(async (opts: Opts) => {
    const hasName = !!opts.name?.trim();
    const noName = !!opts.noName;
    if (hasName === noName) {
      cliError("Provide exactly one of --name <…> or --no-name.");
      return;
    }

    await withNameCommandContext(opts, async (ctx) => {
      // Default index 0: persist the first public account if the wallet is empty
      // so init-profile works without a prior next-fresh-address / balances run.
      const indexFlag = opts.index ?? "0";
      const idx = parseFromIndex(indexFlag);
      if (idx === 0) {
        const publicStorage = makePublicAccountsStorage(
          ctx.walletDir,
          ctx.mnemonic,
          ctx.password
        );
        if (!publicStorage.getAccount(0)) {
          const [created] = publicStorage.addNextAccounts(1);
          if (!ctx.nonInteractive) {
            console.log(
              chalk.dim(`Created public account index 0: ${created!.address}`)
            );
          }
        }
      }

      const signer = resolveRegisterSigner({
        walletDir: ctx.walletDir,
        mnemonic: ctx.mnemonic,
        password: ctx.password,
        indexFlag,
        ownerPriv: ctx.ownerPriv,
        dryRun: ctx.dryRun,
      });

      const keypair = deriveStealthKeypair(ctx.mnemonic, ctx.chainId);
      const stealthStorage = makeStealthAccountsStorage(
        ctx.walletDir,
        ctx.password
      );
      const hashes: string[] = [];

      const registryNeeded = await needsStealthRegistryUpdate({
        client: ctx.client,
        registrant: signer.address,
        stealthMetaAddress: keypair.stealthMetaAddress,
        chainId: ctx.chainId,
      });
      const registryTx: PreparedTx | null = registryNeeded
        ? prepareRegisterStealthKeys({
            stealthMetaAddress: keypair.stealthMetaAddress,
            account: signer.address,
          })
        : null;

      if (noName) {
        if (!registryTx) {
          stealthStorage.setMeta({
            metaAddressURI: keypair.stealthMetaAddressURI,
          });
          const result = {
            action: "init-profile",
            name: null,
            owner: signer.address,
            index: signer.index,
            stealthMetaAddressURI: keypair.stealthMetaAddressURI,
            registry: "already-registered",
            txs: [] as string[],
            urls: [] as string[],
          };
          if (ctx.nonInteractive) logCliJson(result);
          else {
            console.log(
              chalk.green(
                `Stealth keys already registered on ERC-6538 for ${signer.address}`
              )
            );
            console.log(
              chalk.dim(`stealth meta: ${keypair.stealthMetaAddressURI}`)
            );
          }
          return;
        }

        if (ctx.dryRun) {
          await simulatePreparedTxs(ctx.client, signer.address, [registryTx]);
          printPreparedTxs([registryTx], signer.address, {
            title: "init-profile ERC-6538 registerKeys (not submitted)",
          });
          if (ctx.nonInteractive) {
            logCliJson({
              action: "init-profile",
              name: null,
              owner: signer.address,
              index: signer.index,
              stealthMetaAddressURI: keypair.stealthMetaAddressURI,
              dryRun: true,
            });
          }
          return;
        }

        if (!signer.privateKey) {
          throw new Error("Missing private key. Pass --owner-priv if needed.");
        }
        await maybeConfirm(
          ctx.nonInteractive,
          `Register scheme-1 stealth keys on ERC-6538 for ${signer.address}?`
        );
        const [h] = await broadcastPreparedTxs({
          client: ctx.client,
          rpcUrl: ctx.rpcUrl,
          privateKey: signer.privateKey,
          from: signer.address,
          txs: [registryTx],
          nonInteractive: true,
        });
        hashes.push(h!);

        stealthStorage.setMeta({
          metaAddressURI: keypair.stealthMetaAddressURI,
        });

        const result = {
          action: "init-profile",
          name: null,
          owner: signer.address,
          index: signer.index,
          stealthMetaAddressURI: keypair.stealthMetaAddressURI,
          txs: hashes,
          urls: hashes.map((hx) => etherscanTxUrl(ctx.chainId, hx)),
        };
        if (ctx.nonInteractive) logCliJson(result);
        else {
          console.log(
            chalk.green(
              `Registered stealth keys on ERC-6538 for ${signer.address}`
            )
          );
          console.log(
            chalk.dim(`stealth meta: ${keypair.stealthMetaAddressURI}`)
          );
          for (const url of result.urls) console.log(chalk.dim(url));
        }
        return;
      }

      // --name path
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

      /** Post-commit (or reuse) calls from the same EOA, batched via 7702 when 2+. */
      let batchTxs: PreparedTx[] = [];
      let finishStep = "reveal";

      if (needsRegister) {
        const secret = generateSecret();
        const years = Number(opts.years ?? "1");
        const durationSeconds = defaultDurationSeconds(years);
        let commitTx: PreparedTx;
        let finishTx: PreparedTx;
        let feeWei: bigint;

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
          ownership = predictEnsOwnership({
            parsed,
            owner: signer.address,
          });
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
          ownership = await predictNftOwnership({
            client: ctx.client,
            parsed: { ...parsed, protocol: parsed.protocol },
            owner: signer.address,
          });
        }

        const reverseTx =
          parsed.protocol === "ens"
            ? null // ENS register already sets reverseRecord: true
            : prepareSetReverse({ parsed, ownership });

        const textTx =
          parsed.protocol === "ens"
            ? prepareEnsPublicResolverSetText({
                parsed,
                key: STEALTH_TEXT_RECORD_KEY,
                value: keypair.stealthMetaAddressURI,
              })
            : await prepareSetText({
                client: ctx.client,
                parsed,
                ownership,
                key: STEALTH_TEXT_RECORD_KEY,
                value: keypair.stealthMetaAddressURI,
              });

        batchTxs = [
          finishTx,
          ...(reverseTx ? [reverseTx] : []),
          textTx,
          ...(registryTx ? [registryTx] : []),
        ];

        if (!ctx.nonInteractive) {
          console.log(
            chalk.dim(
              `Register ${parsed.name} → ${signer.address} (fee ${formatEther(feeWei)} ETH)`
            )
          );
          console.log(
            chalk.dim(
              `Plan: commit → wait 60s → one EIP-7702 UserOp (${summarizeSteps(batchTxs)})`
            )
          );
        }

        if (ctx.dryRun) {
          // Reveal/register + records cannot be UserOp-simulated until the
          // commitment exists on-chain (and would AA21/prefund-fail anyway).
          await simulatePreparedTxs(ctx.client, signer.address, [commitTx]);
          printPreparedTxs([commitTx], signer.address, {
            title: "init-profile step 1: commit (EOA, not submitted)",
          });
          const needsDelegation = await needsSimple7702Authorization(
            ctx.client,
            signer.address
          );
          printPreparedTxs(batchTxs, signer.address, {
            title: "init-profile step 2: EIP-7702 UserOp (planned, not simulated)",
          });
          console.log(
            chalk.dim(
              `Step 2 (${summarizeSteps(batchTxs)}) runs after commit + ${MIN_COMMITMENT_AGE_SECONDS}s wait; skipped UserOp simulation until then.`
            )
          );
          console.log(
            chalk.dim(
              needsDelegation
                ? "EIP-7702 delegation will be included in the UserOp."
                : "Account already delegates to Simple7702; UserOp skips re-authorization."
            )
          );
          if (ctx.nonInteractive) {
            logCliJson({
              action: "init-profile",
              name: parsed.name,
              protocol: parsed.protocol,
              owner: signer.address,
              stealthMetaAddressURI: keypair.stealthMetaAddressURI,
              dryRun: true,
              mode: "commit-then-eip7702-userop",
              implementation: SIMPLE_7702_IMPLEMENTATION,
              commit: commitTx,
              userOpCalls: batchTxs,
              userOpSimulated: false,
            });
          }
          return;
        }

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

        const fees = await estimateEip7702BatchUserOpFee({
          client: ctx.client,
          chainId: ctx.chainId,
          senderAddress: signer.address,
          calls: batchTxs.map(toBatchCall),
          privateKey: signer.privateKey,
        });
        if (!ctx.nonInteractive) printFeePreview(fees);

        await maybeConfirm(
          ctx.nonInteractive,
          `Submit ${summarizeSteps(batchTxs)} as one EIP-7702 UserOp from ${signer.address}?\n  ${feeConfirmLine(fees)}`
        );

        const sent = await sendEip7702BatchUserOperation({
          client: ctx.client,
          chainId: ctx.chainId,
          privateKey: signer.privateKey,
          calls: batchTxs.map(toBatchCall),
        });
        hashes.push(sent.txHash);

        stealthStorage.setMeta({
          metaAddressURI: keypair.stealthMetaAddressURI,
          name: parsed.name,
        });

        try {
          const ethNames = createEthereumNames({ rpcUrl: ctx.rpcUrl });
          const published = await ethNames.getText(
            parsed.name,
            STEALTH_TEXT_RECORD_KEY
          );
          if (
            published &&
            published.toLowerCase() !==
              keypair.stealthMetaAddressURI.toLowerCase()
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
          action: "init-profile",
          name: parsed.name,
          protocol: parsed.protocol,
          owner: signer.address,
          index: signer.index,
          stealthMetaAddressURI: keypair.stealthMetaAddressURI,
          mode: "commit-then-eip7702-userop",
          userOpHash: sent.userOpHash,
          txs: hashes,
          urls: hashes.map((h) => etherscanTxUrl(ctx.chainId, h)),
        };
        if (ctx.nonInteractive) logCliJson(result);
        else {
          console.log(
            chalk.green(`Initialized wallet identity ${parsed.name}`)
          );
          console.log(
            chalk.dim(`stealth meta: ${keypair.stealthMetaAddressURI}`)
          );
          console.log(
            chalk.dim(
              `Batched ${batchTxs.length} calls via EIP-7702 (${finishStep} + records${registryTx ? " + registerKeys" : ""}).`
            )
          );
          for (const url of result.urls) console.log(chalk.dim(url));
        }
        return;
      }

      // Reuse owned name: skip commit/reveal; only apply missing reverse/text/registry.
      if (!ctx.nonInteractive) {
        console.log(chalk.dim(`Reusing owned name ${parsed.name}`));
      }
      if (!ownership) {
        ownership = await readNameOwnership(ctx.client, parsed);
      }

      // Prefer owner for wrapped ENS (manager is the NameWrapper contract).
      const recordAddress = ownership.wrapped
        ? ownership.owner
        : ownership.manager;
      const recordSigner = resolveNameSigner({
        requiredAddress: recordAddress,
        walletDir: ctx.walletDir,
        mnemonic: ctx.mnemonic,
        password: ctx.password,
        indexFlag: opts.index,
        ownerPriv: ctx.ownerPriv,
        dryRun: ctx.dryRun,
      });

      const ethNames = createEthereumNames({ rpcUrl: ctx.rpcUrl });
      const wantName = parsed.name.toLowerCase();
      const wantMeta = keypair.stealthMetaAddressURI.toLowerCase();

      let needsReverse = true;
      try {
        const primaries = await ethNames.reverseAll(recordSigner.address);
        const current =
          parsed.protocol === "ens"
            ? primaries.ens
            : parsed.protocol === "gns"
              ? primaries.gns
              : primaries.wns;
        if (current && current.toLowerCase() === wantName) {
          needsReverse = false;
          if (!ctx.nonInteractive) {
            console.log(
              chalk.dim(
                `Reverse already set to ${parsed.name}; skipping set-reverse.`
              )
            );
          }
        }
      } catch {
        needsReverse = true;
      }

      let needsText = true;
      try {
        const existingText = await ethNames.getText(
          parsed.name,
          STEALTH_TEXT_RECORD_KEY
        );
        if (existingText && existingText.toLowerCase() === wantMeta) {
          needsText = false;
          if (!ctx.nonInteractive) {
            console.log(
              chalk.dim(
                `${STEALTH_TEXT_RECORD_KEY} already set; skipping set-text.`
              )
            );
          }
        }
      } catch {
        needsText = true;
      }

      if (!registryTx && !ctx.nonInteractive) {
        console.log(
          chalk.dim(
            `ERC-6538 already has scheme-1 keys for ${signer.address}; skipping registerKeys.`
          )
        );
      }

      const reverseTx = needsReverse
        ? prepareSetReverse({ parsed, ownership })
        : null;
      const textTx = needsText
        ? await prepareSetText({
            client: ctx.client,
            parsed,
            ownership,
            key: STEALTH_TEXT_RECORD_KEY,
            value: keypair.stealthMetaAddressURI,
          })
        : null;

      const sameEoa =
        recordSigner.address.toLowerCase() === signer.address.toLowerCase();
      // Records from the name manager/owner; registry must be from the index EOA.
      const recordBatch: PreparedTx[] = [
        ...(reverseTx ? [reverseTx] : []),
        ...(textTx ? [textTx] : []),
        ...(registryTx && sameEoa ? [registryTx] : []),
      ];
      const separateRegistry =
        registryTx && !sameEoa ? registryTx : null;

      if (recordBatch.length === 0 && !separateRegistry) {
        stealthStorage.setMeta({
          metaAddressURI: keypair.stealthMetaAddressURI,
          name: parsed.name,
        });
        const result = {
          action: "init-profile",
          name: parsed.name,
          protocol: parsed.protocol,
          owner: signer.address,
          index: signer.index,
          stealthMetaAddressURI: keypair.stealthMetaAddressURI,
          mode: "reuse-noop",
          txs: [] as string[],
          urls: [] as string[],
        };
        if (ctx.nonInteractive) logCliJson(result);
        else {
          console.log(
            chalk.green(
              `${parsed.name} already initialized for ${signer.address} (nothing to submit)`
            )
          );
          console.log(
            chalk.dim(`stealth meta: ${keypair.stealthMetaAddressURI}`)
          );
        }
        return;
      }

      if (ctx.dryRun) {
        if (recordBatch.length >= 2) {
          const needsDelegation = await needsSimple7702Authorization(
            ctx.client,
            recordSigner.address
          );
          const fees = await estimateEip7702BatchUserOpFee({
            client: ctx.client,
            chainId: ctx.chainId,
            senderAddress: recordSigner.address,
            calls: recordBatch.map(toBatchCall),
            privateKey: recordSigner.privateKey,
          });
          printPreparedTxs(recordBatch, recordSigner.address, {
            title: "init-profile EIP-7702 UserOp (not submitted)",
          });
          printFeePreview(fees);
          console.log(
            chalk.dim(
              needsDelegation
                ? "EIP-7702 delegation will be included in the UserOp."
                : "Account already delegates to Simple7702; UserOp skips re-authorization."
            )
          );
        } else if (recordBatch.length === 1) {
          await simulatePreparedTxs(
            ctx.client,
            recordSigner.address,
            recordBatch
          );
          printPreparedTxs(recordBatch, recordSigner.address, {
            title: "init-profile EOA tx (not submitted)",
          });
          const fees = await estimateEoaTxFeePreview(ctx.client, {
            to: recordBatch[0]!.to,
            from: recordSigner.address,
            data: recordBatch[0]!.data,
            value: recordBatch[0]!.value,
          });
          printFeePreview(fees);
        }
        if (separateRegistry) {
          await simulatePreparedTxs(ctx.client, signer.address, [
            separateRegistry,
          ]);
          printPreparedTxs([separateRegistry], signer.address, {
            title: "init-profile registerKeys (separate EOA, not submitted)",
          });
        }
        if (ctx.nonInteractive) {
          logCliJson({
            action: "init-profile",
            name: parsed.name,
            protocol: parsed.protocol,
            owner: signer.address,
            stealthMetaAddressURI: keypair.stealthMetaAddressURI,
            dryRun: true,
            mode:
              recordBatch.length >= 2
                ? "eip7702-userop"
                : recordBatch.length === 1
                  ? "eoa"
                  : "registry-only",
            skipped: {
              reverse: !needsReverse,
              text: !needsText,
              registerKeys: !registryTx,
            },
            userOpCalls: recordBatch.length >= 2 ? recordBatch : undefined,
            eoaCalls: recordBatch.length === 1 ? recordBatch : undefined,
            separateRegistry: separateRegistry ?? undefined,
          });
        }
        return;
      }

      if (recordBatch.length > 0 && !recordSigner.privateKey) {
        throw new Error("Missing private key for record updates.");
      }
      if (separateRegistry && !signer.privateKey) {
        throw new Error("Missing private key for ERC-6538 registerKeys.");
      }

      if (recordBatch.length >= 2 && recordSigner.privateKey) {
        const fees = await estimateEip7702BatchUserOpFee({
          client: ctx.client,
          chainId: ctx.chainId,
          senderAddress: recordSigner.address,
          calls: recordBatch.map(toBatchCall),
          privateKey: recordSigner.privateKey,
        });
        if (!ctx.nonInteractive) printFeePreview(fees);
        await maybeConfirm(
          ctx.nonInteractive,
          `Submit ${summarizeSteps(recordBatch)} as one EIP-7702 UserOp from ${recordSigner.address}?\n  ${feeConfirmLine(fees)}`
        );
        const sent = await sendEip7702BatchUserOperation({
          client: ctx.client,
          chainId: ctx.chainId,
          privateKey: recordSigner.privateKey,
          calls: recordBatch.map(toBatchCall),
        });
        hashes.push(sent.txHash);
      } else if (recordBatch.length === 1 && recordSigner.privateKey) {
        const only = recordBatch[0]!;
        const fees = await estimateEoaTxFeePreview(ctx.client, {
          to: only.to,
          from: recordSigner.address,
          data: only.data,
          value: only.value,
        });
        if (!ctx.nonInteractive) printFeePreview(fees);
        await maybeConfirm(
          ctx.nonInteractive,
          `Submit ${only.step} from ${recordSigner.address}?\n  ${feeConfirmLine(fees)}`
        );
        const [h] = await broadcastPreparedTxs({
          client: ctx.client,
          rpcUrl: ctx.rpcUrl,
          privateKey: recordSigner.privateKey,
          from: recordSigner.address,
          txs: [only],
          nonInteractive: true,
        });
        hashes.push(h!);
      }

      if (separateRegistry && signer.privateKey) {
        const fees = await estimateEoaTxFeePreview(ctx.client, {
          to: separateRegistry.to,
          from: signer.address,
          data: separateRegistry.data,
          value: separateRegistry.value,
        });
        if (!ctx.nonInteractive) printFeePreview(fees);
        await maybeConfirm(
          ctx.nonInteractive,
          `Register scheme-1 stealth keys on ERC-6538 for ${signer.address}?\n  ${feeConfirmLine(fees)}`
        );
        const [regHash] = await broadcastPreparedTxs({
          client: ctx.client,
          rpcUrl: ctx.rpcUrl,
          privateKey: signer.privateKey,
          from: signer.address,
          txs: [separateRegistry],
          nonInteractive: true,
        });
        hashes.push(regHash!);
      }

      stealthStorage.setMeta({
        metaAddressURI: keypair.stealthMetaAddressURI,
        name: parsed.name,
      });

      try {
        const published = await ethNames.getText(
          parsed.name,
          STEALTH_TEXT_RECORD_KEY
        );
        if (
          published &&
          published.toLowerCase() !==
            keypair.stealthMetaAddressURI.toLowerCase()
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
        action: "init-profile",
        name: parsed.name,
        protocol: parsed.protocol,
        owner: signer.address,
        index: signer.index,
        stealthMetaAddressURI: keypair.stealthMetaAddressURI,
        mode: "reuse",
        skipped: {
          reverse: !needsReverse,
          text: !needsText,
          registerKeys: !registryTx,
        },
        txs: hashes,
        urls: hashes.map((h) => etherscanTxUrl(ctx.chainId, h)),
      };
      if (ctx.nonInteractive) logCliJson(result);
      else {
        console.log(chalk.green(`Initialized wallet identity ${parsed.name}`));
        console.log(
          chalk.dim(`stealth meta: ${keypair.stealthMetaAddressURI}`)
        );
        for (const url of result.urls) console.log(chalk.dim(url));
      }
    });
  });
}
