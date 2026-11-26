import type { AssetAmount, Host } from "@kohaku-eth/plugins";
import { extendedEthPoolSet, TornadoInstances } from "@kohaku-eth/tornado-cash";
import { decodeEventLog, getAddress, parseAbi, toHex, type Hex } from "viem";
import { recordSubmission } from "./activity-log.js";
import { listTornadoUnspentNotes, type AnyPlugin, type SupportedProtocol } from "./plugins.js";
import { selectTornadoWithdrawalNotes } from "./tornado-unshield-pools.js";
import type { KohakuPublicClient } from "./rpc.js";

export type TornadoExitMode = "paymaster" | "relayer";
const hashPattern = /^0x[0-9a-fA-F]{64}$/;
const jobPattern = /^[a-zA-Z0-9_-]{1,256}$/;
const withdrawalEvent = parseAbi(["event Withdrawal(address to, bytes32 nullifierHash, address indexed relayer, uint256 fee)"]);

export function resolveTornadoExitMode(opts: {
  exitMode?: string; protocol: SupportedProtocol; privateTransfer?: boolean;
  tailCalls?: string; amountMax?: boolean;
}): TornadoExitMode {
  const mode = opts.exitMode ?? "paymaster";
  if (mode !== "paymaster" && mode !== "relayer") throw new Error("--exit-mode must be paymaster or relayer.");
  if (opts.exitMode !== undefined && opts.protocol !== "tornado") throw new Error("--exit-mode is only supported with --protocol tornado.");
  if (mode === "relayer") {
    if (opts.privateTransfer) throw new Error("Classic relayer exits are only supported by unshield, not private-transfer or transfer --from tornado.");
    if (opts.tailCalls !== undefined) throw new Error("Classic relayer exits do not support --tail-calls.");
    if (opts.amountMax) throw new Error("Classic relayer exits require one explicit pool denomination; use --amount-formatted or --amount-wei instead of --amount-max.");
  }
  return mode;
}

export function classicTornadoRelayerPools(chainId: bigint, token: {
  isEth: boolean; tokenAddress: string;
}) {
  const extended = extendedEthPoolSet(chainId);
  const asset = token.isEth ? 0n : BigInt(token.tokenAddress);
  const pools = TornadoInstances[Number(chainId) as keyof typeof TornadoInstances] ?? [];
  const selected = pools.filter((entry) => entry.asset === asset && !extended.has(entry.address));
  if (!selected.length) throw new Error("This asset has no original Tornado pools available for classic relayer exits.");
  return selected;
}

export function classicTornadoRelayerPool(chainId: bigint, amount: bigint, token: {
  isEth: boolean; tokenAddress: string;
}) {
  const pool = classicTornadoRelayerPools(chainId, token).find((entry) => entry.denomination === amount);
  if (!pool || amount <= 0n) throw new Error("Classic relayer exits require exactly one original Tornado pool denomination. Extended pools are not supported.");
  return pool;
}

type RelayerWithdrawal = {
  mode: "relayer"; poolAddress: bigint; relayerUrl: string; fee: bigint; denomination: bigint;
  proof: { proof: Hex; args: [Hex, Hex, Hex, Hex, Hex, Hex] };
};
export type ClassicTornadoRelayerQuote = {
  operation: { withdrawals: [RelayerWithdrawal] };
  chainId: bigint; poolAddress: Hex; recipient: Hex; rewardAccount: Hex; nullifierHash: Hex;
  relayerUrl: string; fee: bigint; denomination: bigint; net: bigint;
};

function relayerOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash || url.pathname !== "/" ||
      !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(url.hostname) ||
      /(?:^|\.)(?:localhost|local|internal)$|(?:^|\.)home\.arpa$/i.test(url.hostname)) {
    throw new Error("Classic relayer must use a public HTTPS hostname without credentials, port, or path.");
  }
  return url.origin;
}

/** Validate the proof-bound payout, independently of the relayer's later job response. */
export function validateClassicTornadoRelayerOperation(opts: {
  operation: unknown; chainId: bigint; amount: bigint; recipient: Hex;
  token: { isEth: boolean; tokenAddress: string };
}): ClassicTornadoRelayerQuote {
  const pool = classicTornadoRelayerPool(opts.chainId, opts.amount, opts.token);
  const operation = opts.operation as { withdrawals?: RelayerWithdrawal[] };
  const withdrawal = operation?.withdrawals?.[0];
  if (operation?.withdrawals?.length !== 1 || !withdrawal || withdrawal.mode !== "relayer" ||
      withdrawal.poolAddress !== pool.address || withdrawal.denomination !== opts.amount ||
      typeof withdrawal.fee !== "bigint" || withdrawal.fee <= 0n || withdrawal.fee >= opts.amount ||
      withdrawal.fee * 10_000n > opts.amount * 2_000n ||
      !withdrawal.proof || !/^0x[0-9a-fA-F]{512}$/.test(withdrawal.proof.proof) ||
      !Array.isArray(withdrawal.proof.args) || withdrawal.proof.args.length !== 6) {
    throw new Error("The SDK returned an invalid single-note classic relayer withdrawal.");
  }
  const args = withdrawal.proof.args;
  try {
    if (!hashPattern.test(args[0]) || !hashPattern.test(args[1]) ||
        BigInt(args[2]) !== BigInt(opts.recipient) || BigInt(opts.recipient) === 0n ||
        BigInt(args[3]) <= 0n || BigInt(args[3]) >= (1n << 160n) ||
        BigInt(args[4]) !== withdrawal.fee || BigInt(args[5]) !== 0n) throw new Error();
  } catch { throw new Error("The relayer proof does not match the recipient, fee, reward account, or zero refund."); }
  return {
    operation: operation as { withdrawals: [RelayerWithdrawal] }, chainId: opts.chainId,
    poolAddress: toHex(pool.address, { size: 20 }), recipient: getAddress(opts.recipient),
    rewardAccount: toHex(BigInt(args[3]), { size: 20 }), nullifierHash: args[1],
    relayerUrl: relayerOrigin(withdrawal.relayerUrl), fee: withdrawal.fee,
    denomination: opts.amount, net: opts.amount - withdrawal.fee,
  };
}

export async function prepareClassicTornadoRelayerUnshield(opts: {
  plugin: AnyPlugin; chainId: bigint; asset: AssetAmount; recipient: Hex;
  token: { isEth: boolean; tokenAddress: string };
}): Promise<ClassicTornadoRelayerQuote> {
  const pool = classicTornadoRelayerPool(opts.chainId, opts.asset.amount, opts.token);
  const notes = await listTornadoUnspentNotes(opts.plugin, opts.asset.asset);
  const selected = selectTornadoWithdrawalNotes(notes, opts.asset.amount);
  if (selected.length !== 1 || selected[0]!.pool !== pool.address || selected[0]!.balance !== pool.denomination) {
    throw new Error("Classic relayer exits spend exactly one unspent original-pool note. Choose a denomination held by one note.");
  }
  if (!opts.plugin.prepareUnshield) throw new Error("Tornado plugin does not expose prepareUnshield.");
  const operation = await opts.plugin.prepareUnshield(opts.asset, opts.recipient, { mode: "relayer" } as never);
  return validateClassicTornadoRelayerOperation({ operation, chainId: opts.chainId,
    amount: opts.asset.amount, recipient: opts.recipient, token: opts.token });
}

async function relayerJson(host: Host, url: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const response = await host.network.fetch(url, { ...init, redirect: "error", credentials: "omit",
    referrerPolicy: "no-referrer", signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`Classic relayer returned HTTP ${response.status}.`);
  // Relayer jobs and acknowledgements are small; never consume an unbounded reply.
  const reader = response.body?.getReader();
  let text = "";
  if (reader) {
    const decoder = new TextDecoder();
    let bytes = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > 65_536) throw new Error("Classic relayer response is too large.");
        text += decoder.decode(chunk.value, { stream: true });
      }
      text += decoder.decode();
    } finally { await reader.cancel().catch(() => {}); }
  } else {
    text = await response.text();
    if (text.length > 65_536) throw new Error("Classic relayer response is too large.");
  }
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Classic relayer returned invalid JSON.");
  return value as Record<string, unknown>;
}

/** One POST only. A job acknowledgement becomes success only after a matching pool event and receipt. */
export async function broadcastClassicTornadoRelayerUnshield(opts: {
  quote: ClassicTornadoRelayerQuote; host: Host; client: KohakuPublicClient;
  timeoutMs?: number; pollMs?: number;
}): Promise<{ id: string; txHash: Hex; relayerUrl: string }> {
  const { quote, host, client } = opts;
  const withdrawal = quote.operation.withdrawals[0];
  const checked = validateClassicTornadoRelayerOperation({ operation: quote.operation, chainId: quote.chainId,
    amount: quote.denomination, recipient: quote.recipient, token: {
      isEth: (TornadoInstances[Number(quote.chainId) as keyof typeof TornadoInstances] ?? []).find(pool => pool.address === withdrawal.poolAddress)?.asset === 0n,
      tokenAddress: toHex((TornadoInstances[Number(quote.chainId) as keyof typeof TornadoInstances] ?? []).find(pool => pool.address === withdrawal.poolAddress)?.asset ?? 0n, { size: 20 }),
    } });
  if (checked.poolAddress !== quote.poolAddress || checked.relayerUrl !== quote.relayerUrl || checked.fee !== quote.fee || checked.net !== quote.net ||
      checked.nullifierHash !== quote.nullifierHash || checked.rewardAccount !== quote.rewardAccount) throw new Error("The relayer operation changed after review.");
  const updateActivity = recordSubmission({ relayerUrl: quote.relayerUrl, poolAddress: quote.poolAddress,
    nullifierHash: quote.nullifierHash }, { requirePersistence: true });
  let jobId: string | undefined;
  let txHash: Hex | undefined;
  try {
    const ack = await relayerJson(host, `${quote.relayerUrl}/v1/tornadoWithdraw`, { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ proof: withdrawal.proof.proof,
        args: withdrawal.proof.args, contract: quote.poolAddress }) });
    if (typeof ack.id !== "string" || !jobPattern.test(ack.id)) throw new Error("Classic relayer returned no usable job ID.");
    jobId = ack.id;
    updateActivity({ relayerJobId: jobId });
    const deadline = Date.now() + (opts.timeoutMs ?? 180_000);
    do {
      const job = await relayerJson(host, `${quote.relayerUrl}/v1/jobs/${encodeURIComponent(jobId)}`);
      if (typeof job.txHash === "string" && hashPattern.test(job.txHash)) {
        txHash = job.txHash as Hex;
        updateActivity({ txHash });
        let receipt;
        try { receipt = await client.getTransactionReceipt({ hash: txHash }); } catch { /* May still be pending. */ }
        if (receipt) {
          if (receipt.status !== "success" || receipt.transactionHash.toLowerCase() !== txHash.toLowerCase()) {
            throw new Error("The reported relayer transaction did not succeed.");
          }
          const matched = receipt.logs.some(log => {
            if (log.address.toLowerCase() !== quote.poolAddress.toLowerCase()) return false;
            try {
              const { args } = decodeEventLog({ abi: withdrawalEvent, data: log.data, topics: log.topics });
              return args.to.toLowerCase() === quote.recipient.toLowerCase() &&
                args.nullifierHash.toLowerCase() === quote.nullifierHash.toLowerCase() &&
                args.relayer.toLowerCase() === quote.rewardAccount.toLowerCase() && args.fee === quote.fee;
            } catch { return false; }
          });
          if (!matched) throw new Error("The reported receipt has no matching pool Withdrawal event.");
          updateActivity({ status: "confirmed" });
          return { id: jobId, txHash, relayerUrl: quote.relayerUrl };
        }
      }
      if (job.status === "FAILED") throw new Error("The relayer reports a failed job.");
      if (Date.now() >= deadline) break;
      await new Promise(resolve => setTimeout(resolve, Math.min(opts.pollMs ?? 2_000, Math.max(0, deadline - Date.now()))));
    } while (true);
  } catch { /* A failed response never proves that this executable proof was not submitted. */ }
  const error = new Error(`Classic relayer submission is unconfirmed and may still land. Check ${quote.relayerUrl}${jobId ? `/v1/jobs/${jobId}` : " and the original note"} before preparing another exit.`) as Error & {
    relayerUrl: string; relayerJobId?: string; txHash?: Hex;
  };
  error.relayerUrl = quote.relayerUrl;
  error.relayerJobId = jobId;
  error.txHash = txHash;
  throw error;
}
