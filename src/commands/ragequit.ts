import { startActivityLog } from "../utils/activity-log.js";
import type { Command } from "commander";
import { withNameCommandContext, type NameWalletOpts } from "../lib/names/cli.js";
import { broadcastPreparedTxs, simulatePreparedTxs } from "../lib/names/tx.js";
import { withProtocolRuntime } from "../lib/protocol-runtime.js";
import { resolveShieldSender, toShieldTxs } from "../lib/shield-flow.js";
import { cliOptions, passwordFileOption } from "../utils/cli-command-options.js";
import { syncPluginWithProgress } from "../utils/sync-progress.js";
import { addressishToHex } from "../lib/private-notes.js";
import type { Address } from "viem";

export type RagequitNote = { label: bigint; balance: bigint; approved: boolean; depositor: bigint };

export function assertRagequitNote(note: RagequitNote, sender: string): void {
  if (note.balance <= 0n) throw new Error("Note has no balance to ragequit.");
  if (note.approved) throw new Error("This note is approved; use unshield instead.");
  if (BigInt(sender) !== BigInt(note.depositor)) {
    throw new Error("Ragequit must be sent by the original depositor. Select that account with --from.");
  }
}

type RagequitOpts = NameWalletOpts & { label: string; scheme: string; from?: string; fromPriv?: boolean };

export function registerRagequitCommand(program: Command): void {
  program.command("ragequit")
    .description("Return one unapproved Privacy Pools note's full balance to its original depositor (requires ETH for gas)")
    .requiredOption("--label <label>", "Privacy Pools note label (decimal or hex)")
    .option("--scheme <scheme>", "Note derivation: signature or legacy", "signature")
    .option("--from <address-or-index>", "Original depositor: saved address, HD index, or stealth selector; defaults to note depositor")
    .option("--from-priv", "Derive an unsaved --from HD index from the wallet seed")
    .option("--wallet <name>", cliOptions.walletPickList)
    .option("--password <password>", cliOptions.password)
    .addOption(passwordFileOption())
    .option("--rpc-url <url>", cliOptions.rpcUrl)
    .option("--dataDir <path>", cliOptions.dataDir)
    .option("--broadcast", "Sign and submit; omit to simulate and print payloads")
    .option("--non-interactive", cliOptions.nonInteractiveShieldLike)
    .option("--without-tor", cliOptions.withoutTor)
    .action(async (opts: RagequitOpts) => {
      if (opts.scheme !== "signature" && opts.scheme !== "legacy") throw new Error("--scheme must be signature or legacy.");
      const label = BigInt(opts.label);
      if (label < 0n) throw new Error("--label must be non-negative.");
      await withNameCommandContext(opts, async (ctx) => {
        startActivityLog({ walletDir: ctx.walletDir, password: ctx.password, chainId: ctx.chainId, operation: "ragequit", protocol: "privacy-pools" });
        await withProtocolRuntime({ ...ctx, protocol: "privacy-pools" }, async (_host, plugins) => {
          const plugin = plugins[opts.scheme as "signature" | "legacy"] as unknown as {
            sync(): Promise<void>;
            notes(): Promise<RagequitNote[]>;
            ragequit(labels: bigint[]): Promise<unknown>;
          };
          await syncPluginWithProgress(plugin, "privacy-pools");
          const note = (await plugin.notes()).find((note) => note.label === label);
          if (!note) throw new Error("No unspent Privacy Pools note with this label in the selected scheme.");
          const sender = resolveShieldSender({
            fromValue: opts.from ?? addressishToHex(note.depositor),
            walletDir: ctx.walletDir, mnemonic: ctx.mnemonic, password: ctx.password,
            dryRun: ctx.dryRun, allowDeriveFromMnemonic: !!opts.fromPriv,
          });
          assertRagequitNote(note, sender.senderAddress);
          const txs = toShieldTxs(await plugin.ragequit([label])).map((tx) => ({
            ...tx, to: tx.to as Address, data: tx.data as `0x${string}`, step: "Privacy Pools ragequit",
          }));
          if (txs.length !== 1) throw new Error("Expected exactly one ragequit transaction for this label.");
          await simulatePreparedTxs(ctx.client, sender.senderAddress as Address, txs);
          if (!ctx.broadcast) {
            console.log(JSON.stringify({ mode: "dry-run", protocol: "privacy-pools", label: label.toString(), depositor: sender.senderAddress, transactions: txs }, (_key, value) => typeof value === "bigint" ? value.toString() : value));
            return;
          }
          if (!sender.senderPrivateKey) throw new Error("Cannot sign for the original depositor.");
          const hashes = await broadcastPreparedTxs({
            client: ctx.client, rpcUrl: ctx.rpcUrl, privateKey: sender.senderPrivateKey,
            from: sender.senderAddress as Address, txs, nonInteractive: ctx.nonInteractive,
            confirmMessage: `Ragequit the full balance of Privacy Pools note ${label} back to depositor ${sender.senderAddress}? This reveals the deposit link.`,
          });
          console.log(JSON.stringify({ mode: "broadcast", protocol: "privacy-pools", label: label.toString(), transactions: hashes }));
        });
      });
    });
}
