import { confirm } from "@inquirer/prompts";
import { log, spinner } from "@clack/prompts";
import chalk from "chalk";
import type { Command } from "commander";
import { formatUnits, parseUnits } from "viem";
import { SecretManager, TornadoCashConfigs, type TCNote } from "@kohaku-eth/tornado-cash";

import { withProtocolRuntime } from "../lib/protocol-runtime.js";
import { addressishToHex } from "../lib/private-notes.js";
import { cliOptions } from "../utils/cli-command-options";
import { cliError, cliErrorFromCaught } from "../utils/cli-errors";
import {
  logCliJson,
  manageSpinner,
  quietNonInteractive,
  runQuietSpinner,
} from "../utils/cli-quiet";
import { readSeedKeystore } from "../utils/mnemonic";
import {
  ETH_AS_ERC20,
  listTornadoUnspentNotes,
} from "../utils/plugins";
import {
  DEFAULT_DATA_DIR,
  getRpcChainIdMatchingWallet,
  resolveRpcUrl,
} from "../utils/rpc";
import { resolveTokenMeta } from "../utils/tokens-util";
import { withTor } from "../utils/tor.js";
import { assertTornadoExactPoolDenomination } from "../utils/tornado-pools.js";
import {
  resolveWalletDir,
  resolveWalletNameOrPrompt,
  resolveWalletPassword,
} from "../utils/wallets-util";

type ExportTornadoNoteOpts = {
  wallet?: string;
  password?: string;
  rpcUrl?: string;
  token?: string;
  amountWei?: string;
  amountFormatted?: string;
  nonInteractive?: boolean;
  withoutTor?: boolean;
  dataDir?: string;
};

function numberToBytesLE(value: bigint, length: number): Uint8Array {
  const out = new Uint8Array(length);
  let x = value;
  for (let i = 0; i < length; i++) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}

/** Encode secrets as a classic `tornado-<currency>-<denom>-<chainId>-0x…` note string. */
export function formatLegacyTornadoNote(opts: {
  currency: string;
  denominationLabel: string;
  chainId: bigint;
  nullifier: bigint;
  salt: bigint;
}): string {
  const preimage = new Uint8Array(62);
  preimage.set(numberToBytesLE(opts.nullifier, 31), 0);
  preimage.set(numberToBytesLE(opts.salt, 31), 31);
  const hex = Array.from(preimage, (b) => b.toString(16).padStart(2, "0")).join(
    ""
  );
  return `tornado-${opts.currency.toLowerCase()}-${opts.denominationLabel}-${opts.chainId.toString()}-0x${hex}`;
}

function poolAsBigInt(pool: unknown): bigint {
  if (typeof pool === "bigint") return pool;
  if (typeof pool === "number" && Number.isFinite(pool)) return BigInt(pool);
  if (typeof pool === "string" && pool.trim()) {
    return pool.trim().startsWith("0x")
      ? BigInt(pool.trim())
      : BigInt(pool.trim());
  }
  throw new Error(`Invalid Tornado pool id: ${String(pool)}`);
}

function commitmentAsBigInt(commitment: unknown): bigint {
  if (typeof commitment === "bigint") return commitment;
  if (typeof commitment === "number" && Number.isFinite(commitment)) {
    return BigInt(commitment);
  }
  if (typeof commitment === "string" && commitment.trim()) {
    return commitment.trim().startsWith("0x")
      ? BigInt(commitment.trim())
      : BigInt(commitment.trim());
  }
  throw new Error(`Invalid Tornado commitment: ${String(commitment)}`);
}

type LegacySecretRecord = {
  commitment?: string;
  nullifier?: string;
  salt?: string;
};

async function lookupLegacySecret(
  storageGet: (key: string) => Promise<string | null>,
  chainId: bigint,
  commitment: bigint
): Promise<{ nullifier: bigint; salt: bigint } | null> {
  const config = TornadoCashConfigs[Number(chainId) as 1 | 11155111];
  if (!config) return null;
  const registry = BigInt(config.instanceRegistry.address);
  const key = `tornado-cash-state-${chainId.toString()}-${registry.toString()}`;
  const raw = await storageGet(key);
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const byPool = (parsed as { legacySecrets?: { byPool?: unknown } })
    ?.legacySecrets?.byPool;
  if (!Array.isArray(byPool)) return null;

  const want = commitment.toString(16);
  const want0x = `0x${want}`;
  for (const entry of byPool) {
    if (!Array.isArray(entry) || entry.length < 2) continue;
    const records = entry[1];
    if (!Array.isArray(records)) continue;
    for (const record of records as LegacySecretRecord[]) {
      const c = (record.commitment ?? "").toLowerCase().replace(/^0x/, "");
      if (c !== want && `0x${c}` !== want0x.toLowerCase()) continue;
      if (record.nullifier == null || record.salt == null) continue;
      return {
        nullifier: BigInt(record.nullifier),
        salt: BigInt(record.salt),
      };
    }
  }
  return null;
}

export function registerExportTornadoNoteCommand(program: Command): void {
  program
    .command("export-tornado-note")
    .description(
      "Export unspent Tornado Cash note secret(s) for an exact pool denomination (for import-tornado-note testing)"
    )
    .option("--wallet <name>", cliOptions.walletPickList)
    .option("--password <password>", cliOptions.password)
    .option("--rpc-url <url>", cliOptions.rpcUrl)
    .option("--token <address|symbol|eth>", "Token address or symbol (default: eth)")
    .option("--amount-wei <amount>", "Exact pool denomination in wei/base units")
    .option(
      "--amount-formatted <amount>",
      "Exact pool denomination as a decimal (converted using token decimals)"
    )
    .option("--non-interactive", cliOptions.nonInteractiveCompact)
    .option("--without-tor", cliOptions.withoutTor)
    .option("--dataDir <path>", cliOptions.dataDir)
    .action(async (opts: ExportTornadoNoteOpts) => {
      const amountFlags = [opts.amountWei, opts.amountFormatted].filter(
        Boolean
      ).length;
      if (amountFlags > 1) {
        cliError("Provide only one of --amount-wei or --amount-formatted.");
        return;
      }
      if (amountFlags === 0) {
        cliError("Provide --amount-wei or --amount-formatted.");
        return;
      }

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

      let tokenMeta: Awaited<ReturnType<typeof resolveTokenMeta>>;
      try {
        tokenMeta = await resolveTokenMeta(opts.token, rpcUrl, chainId);
      } catch (e) {
        cliErrorFromCaught(e);
        return;
      }

      let amountWei: bigint;
      try {
        amountWei = opts.amountWei
          ? BigInt(opts.amountWei.trim())
          : parseUnits(opts.amountFormatted!.trim(), tokenMeta.decimals);
        assertTornadoExactPoolDenomination(chainId, amountWei, {
          isEth: tokenMeta.isEth,
          tokenAddress: tokenMeta.tokenAddress,
          symbol: tokenMeta.symbol,
          decimals: tokenMeta.decimals,
        });
      } catch (e) {
        cliErrorFromCaught(e);
        return;
      }

      const amountLabel = `${formatUnits(amountWei, tokenMeta.decimals)} ${tokenMeta.symbol}`;

      if (!opts.nonInteractive) {
        const ok = await confirm({
          message:
            `Reveal Tornado note secret material for ${amountLabel}? ` +
            `Anyone with these strings can withdraw the note(s).`,
          default: false,
        });
        if (!ok) {
          cliError("Cancelled by user.");
          return;
        }
      }

      const quiet = quietNonInteractive(opts.nonInteractive);
      const spin = manageSpinner(spinner(), quiet);
      const useTor = !opts.withoutTor;
      const asset = {
        __type: "erc20" as const,
        contract: (tokenMeta.isEth
          ? ETH_AS_ERC20
          : tokenMeta.tokenAddress) as `0x${string}`,
      };

      try {
        await withTor(
          useTor,
          {
            rpcUrl,
            walletDir,
            onStatus: (message) => {
              spin.start(message);
            },
          },
          async () => {
            if (spin.active) spin.stop("Tor ready.");

            const exported = await runQuietSpinner(
              quiet,
              spin,
              {
                start: "Syncing Tornado Cash and exporting note(s)",
                failure: "Export failed.",
              },
              () =>
                withProtocolRuntime(
                  {
                    protocol: "tornado",
                    rpcUrl,
                    walletDir,
                    password,
                    mnemonic,
                    chainId,
                  },
                  async (host, plugin) => {
                    if (typeof plugin.sync === "function") {
                      await plugin.sync();
                    }
                    const notes = await listTornadoUnspentNotes(plugin, asset);
                    const matching = notes.filter((n) => n.amount === amountWei);
                    if (matching.length === 0) {
                      throw new Error(
                        `No unspent Tornado ${tokenMeta.symbol} note(s) with denomination ${amountLabel}.`
                      );
                    }

                    const secretManager = await SecretManager({
                      host: { keystore: host.keystore },
                      accountIndex: 0,
                    });

                    const poolMeta = assertTornadoExactPoolDenomination(
                      chainId,
                      amountWei,
                      {
                        isEth: tokenMeta.isEth,
                        tokenAddress: tokenMeta.tokenAddress,
                        symbol: tokenMeta.symbol,
                        decimals: tokenMeta.decimals,
                      }
                    );
                    const denominationLabel = formatUnits(
                      amountWei,
                      tokenMeta.decimals
                    );
                    const currency = poolMeta.asset.toLowerCase();

                    const noteStrings: string[] = [];
                    for (const note of matching as TCNote[]) {
                      const commitment = commitmentAsBigInt(note.commitment);
                      const pool = poolAsBigInt(note.pool);
                      let nullifier: bigint;
                      let salt: bigint;

                      if (
                        typeof note.depositIndex === "number" &&
                        note.depositIndex >= 0
                      ) {
                        const secrets = await secretManager.getDepositSecrets({
                          chainId,
                          poolAddress: pool,
                          depositIndex: note.depositIndex,
                        });
                        if (
                          BigInt(secrets.commitment) !== commitment
                        ) {
                          throw new Error(
                            `Derived secrets for depositIndex ${note.depositIndex} do not match note commitment (pool ${addressishToHex(note.pool)}).`
                          );
                        }
                        nullifier = secrets.nullifier;
                        salt = secrets.salt;
                      } else {
                        const legacy = await lookupLegacySecret(
                          (key) => host.storage.get(key),
                          chainId,
                          commitment
                        );
                        if (!legacy) {
                          throw new Error(
                            `Cannot export note at pool ${addressishToHex(note.pool)}: missing depositIndex and no legacy secret in storage.`
                          );
                        }
                        nullifier = legacy.nullifier;
                        salt = legacy.salt;
                      }

                      noteStrings.push(
                        formatLegacyTornadoNote({
                          currency,
                          denominationLabel,
                          chainId,
                          nullifier,
                          salt,
                        })
                      );
                    }

                    return noteStrings;
                  }
                ),
              (notes) => `Exported ${notes.length} note string(s).`
            );

            if (quiet) {
              logCliJson({
                chainId: chainId.toString(),
                token: tokenMeta.symbol,
                amount: amountWei.toString(),
                amountFormatted: formatUnits(amountWei, tokenMeta.decimals),
                notes: exported,
                importCommand: [
                  "kohaku",
                  "import-tornado-note",
                  ...exported,
                ].join(" "),
              });
            } else {
              console.log();
              console.log(
                chalk.yellow.bold(
                  "  ⚠  Anyone with these note strings can withdraw the funds. Treat them like private keys."
                )
              );
              console.log();
              for (const note of exported) {
                console.log(note);
              }
              console.log();
              console.log(chalk.dim("Paste into another wallet with:"));
              console.log(
                chalk.cyan(
                  `  kohaku import-tornado-note ${exported
                    .map((n) => `'${n}'`)
                    .join(" ")} --wallet <other> --password <…> --rpc-url <…>`
                )
              );
              console.log();
              log.success(
                `Exported ${exported.length} unspent ${amountLabel} note(s).`
              );
            }
          }
        );
      } catch (e) {
        cliErrorFromCaught(e);
      } finally {
        if (spin.active) spin.stop();
      }
    });
}
