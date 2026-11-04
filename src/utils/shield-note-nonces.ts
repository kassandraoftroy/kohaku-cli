import type { Host } from "@kohaku-eth/plugins";
import { SignatureSecretManager as TornadoSecrets, TornadoInstances } from "@kohaku-eth/tornado-cash";
import { SignatureSecretManager as PrivacyPoolsSecrets, PrivacyPoolsV1_0xBow } from "@kohaku-eth/privacy-pools";
import { decodeFunctionData, encodeFunctionData, parseAbi, toHex } from "viem";

type Protocol = "tornado" | "privacy-pools";
type Call = { to: string; data: string; value: bigint };
type Secrets = { commitment?: bigint; precommitment?: bigint; nullifierHash: bigint };
type StateSource = {
  sync?: () => Promise<void>;
  notes?: (...args: unknown[]) => Promise<unknown[]>;
  dumpState: () => unknown | Promise<unknown>;
};
const tornadoDeposit = parseAbi(["function deposit(bytes32 commitment) payable"]);
const ppDeposit = parseAbi([
  "function deposit(uint256 precommitment) payable",
  "function deposit(address asset, uint256 value, uint256 precommitment)",
]);

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Cannot verify note nonce freshness: invalid protocol state.");
  }
  return value as Record<string, unknown>;
}

function tuples(value: unknown): Array<[unknown, unknown]> {
  if (!Array.isArray(value) || value.some((entry) => !Array.isArray(entry) || entry.length !== 2)) {
    throw new Error("Cannot verify note nonce freshness: invalid protocol history.");
  }
  return value as Array<[unknown, unknown]>;
}

function integer(value: unknown): bigint {
  if (typeof value !== "string" && typeof value !== "bigint" && typeof value !== "number") {
    throw new Error("Cannot verify note nonce freshness: invalid history key.");
  }
  return BigInt(value);
}

/** Public history retains spent deposits, unlike the wallet's spendable-note list. */
export function shieldNonceHistory(protocol: Protocol, dump: unknown, chainId: bigint, requiredBlock?: bigint) {
  const prefix = protocol === "tornado" ? "tornado-cash-state-" : "privacy-pool-state-";
  const states = Object.entries(object(dump)).filter(([key]) => key.startsWith(`${prefix}${chainId}-`));
  if (states.length !== 1) throw new Error("Cannot verify note nonce freshness: missing or ambiguous synced state.");
  const state = object(states[0]![1]);
  const deposits = tuples(object(state.deposits).depositsTuples);
  const commitments = new Set<bigint>();
  const poolRecords = new Map(tuples(object(state.pools).poolsTuples).map(([pool, record]) => [integer(pool), object(record)]));
  const pools = new Set<bigint>(poolRecords.keys());
  if (protocol === "tornado") {
    // Include every catalog pool, regardless of the asset, denomination exclusions,
    // or paymaster support of the operation being prepared.
    const catalog = TornadoInstances[Number(chainId) as keyof typeof TornadoInstances];
    if (!catalog) throw new Error(`No Tornado catalog for chain ${chainId}.`);
    for (const pool of catalog) pools.add(pool.address);
    for (const [pool, records] of deposits) {
      pools.add(integer(pool));
      for (const [commitment] of tuples(records)) commitments.add(integer(commitment));
    }
    // Tornado's SDK can retain a successful pool while another pool's sync
    // fails. A global cursor alone is therefore insufficient evidence of freshness.
    if (requiredBlock !== undefined) {
      for (const pool of pools) {
        const synced = poolRecords.get(pool)?.lastSyncedBlock;
        if (synced == null || integer(synced) < requiredBlock) {
          throw new Error(`Cannot verify note nonce freshness: Tornado pool ${toHex(pool, { size: 20 })} is not synced through block ${requiredBlock}. Retry the shield after a complete sync.`);
        }
      }
    }
  } else {
    if (requiredBlock !== undefined && integer(object(state.sync).lastSyncedBlock) < requiredBlock) {
      throw new Error(`Cannot verify note nonce freshness: Privacy Pools history is behind block ${requiredBlock}.`);
    }
    for (const [precommitment] of deposits) commitments.add(integer(precommitment));
  }
  const nullifiers = new Set(tuples(object(state.withdrawals).withdrawalsTuples).map(([hash]) => integer(hash)));
  return { pools: [...pools], commitments, nullifiers };
}

/** One sequence for the whole operation, never one sequence per destination pool. */
export async function allocateShieldNonces<T extends Secrets>(opts: {
  startNonce?: number;
  pools: readonly bigint[];
  destinations: readonly bigint[];
  commitments: ReadonlySet<bigint>;
  nullifiers: ReadonlySet<bigint>;
  derive: (nonce: number, pool: bigint) => Promise<T>;
}): Promise<Array<{ nonce: number; pool: bigint; secrets: T }>> {
  if (!opts.pools.length) throw new Error("Cannot verify note nonce freshness: no pools.");
  const result: Array<{ nonce: number; pool: bigint; secrets: T }> = [];
  let nonce = opts.startNonce ?? 0;
  if (!Number.isSafeInteger(nonce) || nonce < 0) throw new Error("Invalid starting note nonce.");
  for (const destination of opts.destinations) {
    if (!opts.pools.includes(destination)) throw new Error("Shield destination is outside the freshness scan.");
    for (;;) {
      if (!Number.isSafeInteger(nonce + 1)) throw new Error("Note nonce range exhausted.");
      const candidate = nonce++;
      let selected: T | undefined;
      let used = false;
      for (const pool of opts.pools) {
        const secrets = await opts.derive(candidate, pool);
        const commitment = secrets.commitment ?? secrets.precommitment;
        if (commitment === undefined) throw new Error("Missing note commitment.");
        if (opts.commitments.has(commitment) || opts.nullifiers.has(secrets.nullifierHash)) {
          used = true;
          break;
        }
        if (pool === destination) selected = secrets;
      }
      if (used) continue;
      if (!selected) throw new Error("Missing destination note secrets.");
      result.push({ nonce: candidate, pool: destination, secrets: selected });
      break;
    }
  }
  return result;
}

/**
 * The SDK still chooses pools/approvals and builds the operation. Replace only
 * note secrets after checking each candidate against fully synced public history.
 * No derivation formula changes, so old notes and mnemonic recovery stay compatible.
 */
export async function freshShieldNoteNonces(opts: {
  protocol: Protocol; host: Host; chainId: bigint; source: StateSource;
  calls: readonly Call[];
}): Promise<Call[]> {
  if (!opts.source.sync) throw new Error("Cannot refresh note nonce freshness history.");
  const requiredBlock = await opts.host.provider.getBlockNumber();
  // These SDK APIs sync and retain spent notes when includeSpent=true. Use their
  // largest discovered index as a hint only: validate the next candidate against
  // public history, which also includes notes outside the SDK's discovery gap.
  const notes = opts.source.notes ? await opts.source.notes([], true) : (await opts.source.sync(), []);
  let startNonce = 0;
  for (const note of notes) {
    const index = object(note)[opts.protocol === "tornado" ? "nonce" : "deposit"];
    if (typeof index === "number" && Number.isSafeInteger(index) && index >= 0) startNonce = Math.max(startNonce, index + 1);
  }
  const history = shieldNonceHistory(opts.protocol, await opts.source.dumpState(), opts.chainId, requiredBlock);
  if (opts.protocol === "tornado") {
    const deposits = opts.calls.filter((call) => call.data.slice(0, 10).toLowerCase() === "0xb214faa5");
    if (!deposits.length) throw new Error("No Tornado deposits to allocate.");
    const manager = await TornadoSecrets({ host: opts.host, accountIndex: 0 });
    const allocations = await allocateShieldNonces({ ...history, startNonce,
      destinations: deposits.map((call) => BigInt(call.to)),
      derive: (nonce, poolAddress) => manager.getSignatureSecrets({ nonce, poolAddress, chainId: opts.chainId }),
    });
    let index = 0;
    return opts.calls.map((call) => {
      if (!deposits.includes(call)) return call;
      // Decode as well as checking the selector: malformed SDK calls fail closed.
      decodeFunctionData({ abi: tornadoDeposit, data: call.data as `0x${string}` });
      const allocation = allocations[index++]!;
      return { ...call, data: encodeFunctionData({ abi: tornadoDeposit, functionName: "deposit",
        args: [toHex(allocation.secrets.commitment, { size: 32 })] }) };
    });
  }
  const config = PrivacyPoolsV1_0xBow[Number(opts.chainId) as keyof typeof PrivacyPoolsV1_0xBow];
  if (!config) throw new Error(`No Privacy Pools deployment for chain ${opts.chainId}.`);
  const entrypointAddress = BigInt(config.entrypoint.entrypointAddress);
  const manager = PrivacyPoolsSecrets({ host: opts.host, accountIndex: 0 });
  // PP's signing envelope binds to the entrypoint, not the individual asset pool.
  // Its deposit index and precommitment already span every pool at that entrypoint.
  const deposits = opts.calls.filter((call) => BigInt(call.to) === entrypointAddress);
  if (!deposits.length) throw new Error("No Privacy Pools deposits to allocate.");
  const allocations = await allocateShieldNonces({ ...history, startNonce, pools: [entrypointAddress],
    destinations: deposits.map(() => entrypointAddress),
    derive: (depositIndex) => Promise.resolve(manager.getDepositSecrets({ depositIndex, entrypointAddress, chainId: opts.chainId })),
  });
  let index = 0;
  return opts.calls.map((call) => {
    if (!deposits.includes(call)) return call;
    const decoded = decodeFunctionData({ abi: ppDeposit, data: call.data as `0x${string}` });
    const precommitment = allocations[index++]!.secrets.precommitment;
    const args = decoded.args.length === 1 ? [precommitment] as const
      : [decoded.args[0], decoded.args[1], precommitment] as const;
    return { ...call, data: encodeFunctionData({ abi: ppDeposit, functionName: "deposit", args }) };
  });
}
