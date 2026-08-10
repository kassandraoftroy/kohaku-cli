import type { Command } from "commander";

import { cliOptions } from "../../utils/cli-command-options.js";
import { cliError, cliErrorFromCaught } from "../../utils/cli-errors.js";
import { readSeedKeystore } from "../../utils/mnemonic.js";
import {
  DEFAULT_DATA_DIR,
  disposePublicClient,
  getRpcChainIdMatchingWallet,
  makePublicClient,
  resolveRpcUrl,
  type KohakuPublicClient,
} from "../../utils/rpc.js";
import { runWithWalletTrafficLog } from "../../utils/tor.js";
import {
  resolveWalletDir,
  resolveWalletNameOrPrompt,
  resolveWalletPassword,
} from "../../utils/wallets-util.js";

export type NameCommandContext = {
  walletName: string;
  walletDir: string;
  password: string;
  mnemonic: string;
  rpcUrl: string;
  chainId: bigint;
  client: KohakuPublicClient;
  nonInteractive: boolean;
  broadcast: boolean;
  dryRun: boolean;
  ownerPriv: boolean;
  dataDir: string;
};

export type NameWalletOpts = {
  wallet?: string;
  password?: string;
  rpcUrl?: string;
  nonInteractive?: boolean;
  broadcast?: boolean;
  ownerPriv?: boolean;
  dataDir?: string;
  index?: string;
};

/**
 * Shared wallet / RPC bootstrap for all name-management commands.
 * Returns null when a soft validation error was already printed.
 */
export async function withNameCommandContext(
  opts: NameWalletOpts,
  run: (ctx: NameCommandContext) => Promise<void>
): Promise<void> {
  const rpcUrl = resolveRpcUrl(opts.rpcUrl);
  if (!rpcUrl) {
    cliError("Missing --rpc-url (or environment variable RPC_URL).");
    return;
  }

  const dataDir = opts.dataDir ?? DEFAULT_DATA_DIR;
  const walletName = await resolveWalletNameOrPrompt({
    dataDir,
    wallet: opts.wallet,
    nonInteractive: opts.nonInteractive,
  });
  if (!walletName) return;

  let walletDir: string;
  try {
    walletDir = resolveWalletDir(dataDir, walletName);
  } catch (e) {
    cliErrorFromCaught(e);
    return;
  }

  const password = await resolveWalletPassword({
    flagPassword: opts.password,
    nonInteractive: opts.nonInteractive,
    validate: (candidate) => {
      readSeedKeystore(candidate, walletDir);
    },
  });
  if (!password) return;

  let mnemonic: string;
  try {
    mnemonic = readSeedKeystore(password, walletDir);
  } catch (e) {
    cliErrorFromCaught(e);
    return;
  }

  let chainId: bigint;
  try {
    chainId = await getRpcChainIdMatchingWallet(rpcUrl, walletDir);
  } catch (e) {
    cliErrorFromCaught(e);
    return;
  }

  const broadcast = !!opts.broadcast;
  const client = await makePublicClient(rpcUrl);
  try {
    await runWithWalletTrafficLog(walletDir, async () => {
      await run({
        walletName,
        walletDir,
        password,
        mnemonic,
        rpcUrl,
        chainId,
        client,
        nonInteractive: !!opts.nonInteractive,
        broadcast,
        dryRun: !broadcast,
        ownerPriv: !!opts.ownerPriv,
        dataDir,
      });
    });
  } catch (e) {
    cliErrorFromCaught(e);
  } finally {
    disposePublicClient(client);
  }
}

/** Shared option registration for name commands. */
export function addNameWalletOptions(cmd: Command): Command {
  return cmd
    .option("--wallet <name>", cliOptions.walletPickList)
    .option("--password <password>", cliOptions.password)
    .option("--rpc-url <url>", cliOptions.rpcUrl)
    .option(
      "--broadcast",
      "Sign and submit on-chain (omit to simulate / print transaction payload only)"
    )
    .option(
      "--owner-priv",
      "Derive --index from the seed when that account is not yet in public accounts"
    )
    .option("--non-interactive", cliOptions.nonInteractiveShieldLike)
    .option("--dataDir <path>", cliOptions.dataDir);
}
