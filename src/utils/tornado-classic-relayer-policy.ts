import { randomBytes } from "node:crypto";
import type { AssetAmount, Host } from "@kohaku-eth/plugins";
import { TornadoCashConfigs, TornadoInstances, type TCPluginParameters } from "@kohaku-eth/tornado-cash";
import { decodeFunctionResult, encodeFunctionData, isAddress, parseAbi, toHex, zeroAddress } from "viem";
import { namehash } from "viem/ens";

type RelayerClient = ReturnType<NonNullable<TCPluginParameters["relayerClientFactory"]>>;
type RelayerStatus = Awaited<ReturnType<RelayerClient["getStatus"]>>;
type RegisteredRelayer = { ensName: string; hostname: string; relayerAddress: bigint; stakeBalance: bigint };
type Candidate = RegisteredRelayer & { status: RelayerStatus };
type RelayerOptions = { mode?: string; preferredRelayersEns?: string[] };

export const CLASSIC_RELAYER_MIN_STAKE = 500n * 10n ** 18n;
const PRIORITY_FEE_FLOOR = 3_000_000_000n;
const WITHDRAW_GAS = 550_000n;
const aggregatorAbi = parseAbi([
  "function relayersData(bytes32[] _relayers, string[] _subdomains) view returns ((address owner, uint256 balance, bool isRegistered, string[20] records)[])",
]);
const DNS_HOSTNAME = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
const LOCAL_HOSTNAME = /(?:^|\.)(?:localhost|local|internal)$|(?:^|\.)home\.arpa$/i;

function statusUrl(hostname: string): string {
  if (hostname.length > 253 || DNS_HOSTNAME.exec(hostname)?.[0] !== hostname || LOCAL_HOSTNAME.test(hostname)) {
    throw new Error("Relayer must use a public DNS hostname without URL components.");
  }
  return `https://${hostname}/status`;
}

export function classicRelayerFeeBounds(chainId: bigint): { minFee: number; maxFee: number } {
  return chainId === 1n ? { minFee: 0.33, maxFee: 0.53 } : { minFee: 0.01, maxFee: 0.30 };
}

// Convert the relayer's decimal percentage without floating-point squaring or
// rounding its stake down. All weights have the same omitted denominator.
function scaledPercent(value: number): bigint {
  const [mantissa, exponent = "0"] = value.toString().split("e");
  const [whole, fractional = ""] = mantissa!.split(".");
  const shift = 20 + Number(exponent) - fractional.length;
  const digits = BigInt(`${whole}${fractional}`);
  return shift >= 0 ? digits * 10n ** BigInt(shift) : digits / 10n ** BigInt(-shift);
}

/** Classic UI score: stake * (1 - ((fee - min) / (max - min))^2). */
export function classicRelayerWeight(stake: bigint, fee: number, chainId: bigint): bigint {
  const { minFee, maxFee } = classicRelayerFeeBounds(chainId);
  if (stake < CLASSIC_RELAYER_MIN_STAKE || !Number.isFinite(fee) || fee < 0 || fee >= maxFee) return 0n;
  const min = scaledPercent(minFee);
  const range = scaledPercent(maxFee) - min;
  const delta = scaledPercent(Math.max(minFee, fee)) - min;
  return stake * (range * range - delta * delta);
}

function randomBelow(limit: bigint): bigint {
  const bits = limit.toString(2).length;
  const bytes = Math.ceil(bits / 8);
  const mask = (1n << BigInt(bits)) - 1n;
  for (;;) {
    const value = BigInt(`0x${randomBytes(bytes).toString("hex")}`) & mask;
    if (value < limit) return value;
  }
}

export function pickClassicRelayer<T extends { stakeBalance: bigint; tornadoServiceFee: number }>(
  candidates: readonly T[], chainId: bigint, draw: (limit: bigint) => bigint = randomBelow,
): T {
  const weights = candidates.map(({ stakeBalance, tornadoServiceFee }) => classicRelayerWeight(stakeBalance, tornadoServiceFee, chainId));
  const total = weights.reduce((sum, weight) => sum + weight, 0n);
  if (total === 0n) throw new Error("No classic relayer passes the current 500 TORN stake, status and fee checks.");
  let position = draw(total);
  if (position < 0n || position >= total) throw new Error("Invalid weighted relayer draw.");
  for (let index = 0; index < candidates.length; index++) {
    if (position < weights[index]!) return candidates[index]!;
    position -= weights[index]!;
  }
  throw new Error("Invalid weighted relayer draw.");
}

export function classicRelayerGasPrice(baseFee: bigint, priorityFee: bigint): bigint {
  if (baseFee < 0n || priorityFee < 0n) throw new Error("Invalid EIP-1559 fee estimate.");
  return baseFee + (priorityFee > PRIORITY_FEE_FLOOR ? priorityFee : PRIORITY_FEE_FLOOR);
}

function executionReverted(error: unknown): boolean {
  return error instanceof Error && /execution reverted|revert(?:ed)?\b/i.test(error.message);
}

/**
 * Uses only the published SDK's Host and relayer-client hooks. The worker saves
 * its refreshed registry snapshot before requesting any status, so status
 * selection can read storage without calling back into that busy worker.
 */
export function createClassicRelayerPolicy(
  originalHost: Host, chainId: bigint,
  draw?: (limit: bigint) => bigint,
) {
  const config = TornadoCashConfigs[Number(chainId) as 1 | 11155111];
  const bounds = classicRelayerFeeBounds(chainId);
  type Preparation = {
    gasPrice?: Promise<bigint>; asset: AssetAmount; options: RelayerOptions;
    selection?: Promise<Candidate>; selectionError?: unknown;
  };
  let active: Preparation | undefined;
  let queue = Promise.resolve();
  function gasPrice(preparation: Preparation): Promise<bigint> {
    // Freeze when the SDK asks, after pool/registry sync, rather than before a
    // potentially long cold sync. Its proof quote and our selection share it.
    return preparation.gasPrice ??= Promise.all([
      originalHost.provider.request({ method: "eth_getBlockByNumber", params: ["latest", false] }),
      originalHost.provider.request({ method: "eth_maxPriorityFeePerGas", params: [] }),
    ]).then(([block, priority]) => {
      const baseFee = (block as { baseFeePerGas?: string })?.baseFeePerGas;
      if (baseFee === undefined) throw new Error("Classic relayer withdrawal requires an EIP-1559 base fee.");
      return classicRelayerGasPrice(BigInt(baseFee), BigInt(priority as string));
    });
  }
  const provider = new Proxy(originalHost.provider, {
    get(target, property) {
      if (property === "request") return async (request: Parameters<Host["provider"]["request"]>[0]) => {
        if (active && request.method === "eth_gasPrice") return toHex(await gasPrice(active));
        return target.request(request);
      };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const host = { ...originalHost, provider };

  async function registeredRelayers(): Promise<RegisteredRelayer[]> {
    const raw = await originalHost.storage.get(`tornado-cash-state-${chainId}-${config.instanceRegistry.address}`);
    const tuples = raw ? JSON.parse(raw)?.relayers?.relayersTuples : undefined;
    if (!Array.isArray(tuples)) throw new Error("Tornado relayer registry snapshot is unavailable.");
    const relayers = tuples.map(([, entry]: [string, Record<string, unknown>]) => ({
      ensName: String(entry.ensName), hostname: String(entry.hostname),
      relayerAddress: BigInt(String(entry.relayerAddress)), stakeBalance: BigInt(String(entry.stakeBalance)),
    }));
    const subdomains = config.ensSubdomainKey === "mainnet-tornado"
      ? ["mainnet-tornado"] : ["mainnet-tornado", config.ensSubdomainKey];
    const hostnameIndex = subdomains.length - 1;
    const read = async (batch: RegisteredRelayer[], names = subdomains): Promise<RegisteredRelayer[]> => {
      try {
        const result = await originalHost.provider.request({ method: "eth_call", params: [{
          to: toHex(config.aggregator.address, { size: 20 }),
          data: encodeFunctionData({ abi: aggregatorAbi, functionName: "relayersData", args: [batch.map(({ ensName }) => namehash(ensName)), names] }),
        }, "latest"] });
        const records = decodeFunctionResult({ abi: aggregatorAbi, functionName: "relayersData", data: result as `0x${string}` });
        if (records.length !== batch.length) throw new Error("Incomplete Tornado relayer registry response.");
        return batch.flatMap((entry, index) => {
          const current = records[index]!;
          // Do not route a proof to a saved hostname whose ENS ownership or URL
          // has changed, even if the SDK's cached registry entry still exists.
          if (!current.isRegistered || current.balance < CLASSIC_RELAYER_MIN_STAKE ||
              BigInt(current.owner) !== entry.relayerAddress || !current.records[0] ||
              current.records[hostnameIndex] !== entry.hostname) return [];
          return [{ ...entry, stakeBalance: current.balance }];
        });
      } catch (error) {
        if (!executionReverted(error)) throw error;
        if (batch.length > 1) {
          const middle = Math.floor(batch.length / 2);
          return [...await read(batch.slice(0, middle), names), ...await read(batch.slice(middle), names)];
        }
        // A broken ENS resolver must not exclude every other registry entry.
        if (names.length) return read(batch, []);
        throw error;
      }
    };
    const fresh: RegisteredRelayer[] = [];
    for (let index = 0; index < relayers.length; index += 16) fresh.push(...await read(relayers.slice(index, index + 16)));
    return fresh;
  }

  async function select(preparation: Preparation): Promise<Candidate> {
    const frozenGasPrice = await gasPrice(preparation);
    const assetAddress = (preparation.asset.asset as { contract?: string }).contract;
    const pool = TornadoInstances[Number(chainId) as 1 | 11155111].find((pool) =>
      pool.denomination === preparation.asset.amount && assetAddress &&
      pool.asset === (assetAddress.toLowerCase() === "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" ? 0n : BigInt(assetAddress)));
    if (!pool) throw new Error("Classic relayer preparation requires one original pool denomination.");
    const registered = await registeredRelayers();
    const preferred = preparation.options.preferredRelayersEns;
    const results = await Promise.all(registered.filter(({ ensName }) => !preferred || preferred.includes(ensName)).map(async (relayer) => {
      try {
        const response = await originalHost.network.fetch(statusUrl(relayer.hostname), { redirect: "error", signal: AbortSignal.timeout(15_000) });
        if (!response.ok) return null;
        const status = await response.json() as RelayerStatus;
        if (!status || status.netId !== Number(chainId) || !Number.isInteger(status.currentQueue) || status.currentQueue < 0 || status.currentQueue > 5 ||
            classicRelayerWeight(relayer.stakeBalance, status.tornadoServiceFee, chainId) === 0n ||
            typeof status.rewardAccount !== "string" || !isAddress(status.rewardAccount, { strict: false }) ||
            status.rewardAccount.toLowerCase() === zeroAddress ||
            (chainId === 1n && BigInt(status.rewardAccount) !== relayer.relayerAddress)) return null;
        let networkFee = frozenGasPrice * WITHDRAW_GAS;
        if (pool.asset !== 0n) {
          const prices = status.ethPrices;
          const price = prices?.[pool.symbol.toLowerCase()] ?? prices?.[pool.symbol.toUpperCase()] ?? prices?.[pool.symbol];
          if (!price || BigInt(price) <= 0n) return null;
          networkFee = networkFee * 10n ** BigInt(pool.decimals) / BigInt(price);
        }
        const fee = networkFee + pool.denomination * BigInt(Math.round(status.tornadoServiceFee * 100)) / 10_000n;
        if (fee * 10_000n > pool.denomination * 2_000n) return null;
        return { ...relayer, status };
      } catch { return null; }
    }));
    const candidates = results.filter((candidate): candidate is Candidate => candidate !== null);
    return pickClassicRelayer(candidates.map((candidate) => ({ ...candidate, tornadoServiceFee: candidate.status.tornadoServiceFee })), chainId, draw);
  }

  const relayerClientFactory: NonNullable<TCPluginParameters["relayerClientFactory"]> = () => ({
    async getStatus(hostname) {
      const preparation = active;
      if (!preparation) throw new Error("Classic relayer status requested outside explicit relayer preparation.");
      preparation.selection ??= select(preparation).catch((error) => { preparation.selectionError = error; throw error; });
      const winner = await preparation.selection;
      // The SDK still validates its fee cap and independent token price before
      // proving, but its cheapest-quote ranking now sees only this random draw.
      if (winner.hostname !== hostname) throw new Error("Relayer was not selected by the classic weighted draw.");
      return winner.status;
    },
    async withdraw() {
      // CLI submission owns the durable journal and receipt/event validation.
      throw new Error("Use the CLI classic relayer broadcaster to submit withdrawals.");
    },
  });

  return {
    host,
    // Classic's lower bound is a weight clamp; it accepts cheaper relayers at
    // full weight. Keep the SDK's independent 20% fee and price safety limits.
    relayerConfig: { minFee: 0, maxFee: bounds.maxFee },
    relayerClientFactory,
    prepare<T>(asset: AssetAmount, options: RelayerOptions | undefined, operation: () => Promise<T>): Promise<T> {
      // Serialize both modes: worker callbacks run outside caller async context,
      // so an instance-local flag must never overlap a paymaster preparation.
      const result = queue.then(async () => {
        if (options?.mode !== undefined && options.mode !== "relayer") return operation();
        const preparation: Preparation = { asset, options: options ?? {} };
        active = preparation;
        try { return await operation(); }
        catch (error) { throw preparation.selectionError ?? error; }
        finally { active = undefined; }
      });
      queue = result.then(() => undefined, () => undefined);
      return result;
    },
  };
}
