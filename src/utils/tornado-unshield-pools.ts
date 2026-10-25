import { TornadoPaymasterConfigs, type TCNote } from "@kohaku-eth/tornado-cash";
import { formatUnits, getAddress, parseAbi, type Address } from "viem";
import type { KohakuPublicClient } from "./rpc.js";
import { tornadoPoolsForChain } from "./tornado-pools.js";

export type TornadoWithdrawalNote = Pick<TCNote, "pool" | "amount" | "balance">;
type PaymasterPool = { pool: Address; adapter: Address };
const PAYMASTER_ABI = parseAbi([
  "function approvedAdapters(address adapter) view returns (bool)",
]);

/** Match the SDK's largest-denomination-first selection without overshooting. */
export function selectTornadoWithdrawalNotes<T extends TornadoWithdrawalNote>(
  notes: readonly T[],
  amount: bigint
): T[] {
  if (amount <= 0n) throw new Error("Amount must be greater than zero.");
  const candidates = notes.filter((note) => note.balance > 0n && note.amount > 0n)
    .sort((a, b) => a.amount > b.amount ? -1 : a.amount < b.amount ? 1 : 0);
  const selected: T[] = [];
  let remaining = amount;
  for (const note of candidates) {
    if (note.amount > remaining) continue;
    selected.push(note);
    remaining -= note.amount;
    if (remaining === 0n) return selected;
  }
  throw new Error(`Insufficient Tornado notes to compose ${amount.toString()} base units exactly.`);
}

/** Check all selected pools, including execution-phase withdrawals in a batch. */
export function tornadoSelectedPaymasterPools(
  chainId: bigint,
  notes: readonly TornadoWithdrawalNote[],
  amount: bigint,
  poolsAccountsMap: Readonly<Record<string, string>> =
    TornadoPaymasterConfigs[Number(chainId) as keyof typeof TornadoPaymasterConfigs]?.poolsAccountsMap ?? {}
): PaymasterPool[] {
  const adapters = new Map(Object.entries(poolsAccountsMap).map(([pool, adapter]) =>
    [BigInt(pool), adapter] as const));
  const selected = selectTornadoWithdrawalNotes(notes, amount);
  const pools = new Map<bigint, PaymasterPool>();
  for (const note of selected) {
    const pool = getAddress(`0x${note.pool.toString(16).padStart(40, "0")}`);
    const adapter = adapters.get(note.pool);
    if (!adapter || BigInt(adapter) === 0n) {
      const meta = tornadoPoolsForChain(chainId).find((p) => BigInt(p.poolAddress) === note.pool);
      const label = meta ? ` (${formatUnits(note.amount, meta.decimals)} ${meta.asset})` : "";
      throw new Error(
        `Tornado pool ${pool}${label} has no paymaster FeeAdapter configured on chain ${chainId}. ` +
        "This unshield cannot proceed until a supported adapter is deployed and configured." +
        (meta?.isNew ? " Use --exclude-new-pools to spend only classic-pool notes." : "")
      );
    }
    pools.set(note.pool, { pool, adapter: getAddress(adapter) });
  }
  return [...pools.values()];
}

export async function assertTornadoUnshieldPoolsDeployed(opts: {
  client: Pick<KohakuPublicClient, "getCode" | "readContract">;
  chainId: bigint;
  notes: readonly TornadoWithdrawalNote[];
  amount: bigint;
}): Promise<void> {
  // Fail on missing map entries before doing any network requests or proving.
  const pools = tornadoSelectedPaymasterPools(opts.chainId, opts.notes, opts.amount);
  const config = TornadoPaymasterConfigs[Number(opts.chainId) as keyof typeof TornadoPaymasterConfigs];
  if (!config) throw new Error(`Tornado paymaster is not configured on chain ${opts.chainId}.`);
  const paymaster = getAddress(config.paymasterAddress);
  const code = await opts.client.getCode({ address: paymaster });
  if (!code || code === "0x") {
    throw new Error(`Tornado paymaster ${paymaster} is not deployed on chain ${opts.chainId}.`);
  }
  await Promise.all(pools.map(async ({ pool, adapter }) => {
    const adapterCode = await opts.client.getCode({ address: adapter });
    if (!adapterCode || adapterCode === "0x") {
      throw new Error(`Tornado pool ${pool} has no deployed paymaster FeeAdapter at ${adapter} on chain ${opts.chainId}.`);
    }
    const approved = await opts.client.readContract({
      address: paymaster,
      abi: PAYMASTER_ABI,
      functionName: "approvedAdapters",
      args: [adapter],
    });
    if (!approved) {
      throw new Error(`Tornado pool ${pool} has a FeeAdapter (${adapter}) that is not approved by paymaster ${paymaster}.`);
    }
  }));
}
