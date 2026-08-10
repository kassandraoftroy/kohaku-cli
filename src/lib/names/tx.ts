import { confirm } from "@inquirer/prompts";
import chalk from "chalk";
import type { Address } from "viem";

import {
  estimateEoaTxFeePreview,
  feeConfirmLine,
  printFeePreview,
} from "../../utils/fee-preview.js";
import { jsonStringifyWithBigInt } from "../../utils/json-bigint.js";
import type { KohakuPublicClient } from "../../utils/rpc.js";
import {
  makeWalletClient,
  sendTransactionAndWait,
  simulateCallOrThrow,
} from "../../utils/viem-tx.js";
import { MIN_COMMITMENT_AGE_SECONDS } from "./constants.js";
import type { PreparedTx } from "./types.js";

export async function maybeConfirm(
  nonInteractive: boolean,
  message: string
): Promise<void> {
  if (nonInteractive) return;
  const ok = await confirm({ message, default: false });
  if (!ok) throw new Error("Cancelled by user.");
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * After commit is mined: wait `minAgeSeconds` from the commit *block timestamp*
 * (registrars require `block.timestamp - commitmentTimestamp >= minAge`).
 *
 * Uses a single wall-clock sleep from that timestamp, then a quick chain-time
 * check in case the local clock is ahead of the chain.
 */
export async function waitUntilCommitmentAged(opts: {
  client: KohakuPublicClient;
  commitTxHash: `0x${string}`;
  /** Minimum seconds after the commit block timestamp (default 60). */
  minAgeSeconds?: bigint;
  nonInteractive: boolean;
}): Promise<void> {
  const minAge = opts.minAgeSeconds ?? MIN_COMMITMENT_AGE_SECONDS;
  const receipt = await opts.client.getTransactionReceipt({
    hash: opts.commitTxHash,
  });
  if (receipt.blockNumber == null) {
    throw new Error(
      `Commit tx ${opts.commitTxHash} has no block number yet; cannot age commitment.`
    );
  }
  const commitBlock = await opts.client.getBlock({
    blockNumber: receipt.blockNumber,
  });
  const readyAtUnix = commitBlock.timestamp + minAge;
  const nowUnix = BigInt(Math.floor(Date.now() / 1000));
  const waitSec =
    readyAtUnix > nowUnix ? Number(readyAtUnix - nowUnix) : 0;

  if (!opts.nonInteractive) {
    console.log(
      chalk.dim(
        waitSec > 0
          ? `Waiting ${waitSec}s for commitment age (60s from commit block ${receipt.blockNumber})…`
          : `Commitment age already elapsed (commit block ${receipt.blockNumber}).`
      )
    );
  }
  if (waitSec > 0) {
    await sleep(waitSec * 1000);
  }

  // Local clock can run ahead of chain time; wait out any remaining skew once.
  for (;;) {
    const latest = await opts.client.getBlock({ blockTag: "latest" });
    if (latest.timestamp >= readyAtUnix) return;
    const remainingSec = Number(readyAtUnix - latest.timestamp);
    if (!opts.nonInteractive) {
      console.log(
        chalk.dim(
          `  Chain still ${remainingSec}s short of commit+${minAge.toString()}s; waiting…`
        )
      );
    }
    await sleep(Math.max(1_000, remainingSec * 1000));
  }
}

export function printPreparedTxs(
  txs: PreparedTx[],
  from: Address,
  opts?: { title?: string }
): void {
  console.log();
  console.log(chalk.bold(opts?.title ?? "Planned transaction(s) (not submitted)"));
  console.log(
    chalk.dim(
      "Add --broadcast to sign and send on-chain. Registration still needs the 60s wait between steps."
    )
  );
  console.log();
  for (const t of txs) {
    console.log(
      chalk.cyan(`${t.step}:`),
      jsonStringifyWithBigInt({
        data: t.data,
        to: t.to,
        from,
        value: t.value.toString(),
      })
    );
  }
}

export async function simulatePreparedTxs(
  client: KohakuPublicClient,
  from: Address,
  txs: PreparedTx[]
): Promise<void> {
  for (const t of txs) {
    await simulateCallOrThrow(
      client,
      { to: t.to, from, data: t.data, value: t.value },
      t.step
    );
  }
}

export async function broadcastPreparedTxs(opts: {
  client: KohakuPublicClient;
  rpcUrl: string;
  privateKey: string;
  from: Address;
  txs: PreparedTx[];
  nonInteractive: boolean;
  confirmMessage?: string;
}): Promise<`0x${string}`[]> {
  const { client, rpcUrl, privateKey, from, txs, nonInteractive } = opts;

  const feePreviews = [];
  for (const t of txs) {
    const fee = await estimateEoaTxFeePreview(client, {
      to: t.to,
      from,
      data: t.data,
      value: t.value,
    });
    feePreviews.push(fee);
    if (!nonInteractive) {
      printFeePreview(fee);
    }
  }

  const msg =
    opts.confirmMessage ??
    `Broadcast ${txs.length} transaction(s) from ${from}? ${feeConfirmLine(feePreviews[0]!)}`;
  await maybeConfirm(nonInteractive, msg);

  const wallet = makeWalletClient(privateKey, client, rpcUrl);
  const hashes: `0x${string}`[] = [];
  for (const t of txs) {
    if (!nonInteractive) {
      console.log(chalk.dim(`Sending ${t.step}…`));
    }
    const hash = await sendTransactionAndWait(wallet, client, {
      to: t.to,
      data: t.data,
      value: t.value,
    });
    hashes.push(hash);
    if (!nonInteractive) {
      console.log(chalk.green(`${t.step} tx: ${hash}`));
    }
  }
  return hashes;
}

export function etherscanTxUrl(chainId: bigint, txHash: string): string {
  const host = chainId === 11155111n ? "sepolia.etherscan.io" : "etherscan.io";
  return `https://${host}/tx/${txHash}`;
}
