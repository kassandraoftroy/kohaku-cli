import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import type { Host } from "@kohaku-eth/plugins";
import { TornadoCashConfigs } from "@kohaku-eth/tornado-cash";
import { decodeFunctionData, encodeFunctionResult, parseAbi, toHex, type ContractFunctionReturnType } from "viem";
import { namehash } from "viem/ens";
import { registerPrivateEnsRpc } from "../src/host/private-ens-rpc.js";
import { withFakeTor } from "./helpers/fake-tor.js";
import {
  CLASSIC_RELAYER_MIN_STAKE, classicRelayerFeeBounds, classicRelayerGasPrice,
  classicRelayerWeight, createClassicRelayerPolicy, pickClassicRelayer,
} from "../src/utils/tornado-classic-relayer-policy.js";

const stake = CLASSIC_RELAYER_MIN_STAKE;
const asset = { asset: { __type: "erc20", contract: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" }, amount: 10n ** 17n } as never;
const aggregatorAbi = parseAbi([
  "function relayersData(bytes32[] _relayers, string[] _subdomains) view returns ((address owner, uint256 balance, bool isRegistered, string[20] records)[])",
]);
type TextRecords = ContractFunctionReturnType<typeof aggregatorAbi, "view", "relayersData">[number]["records"];

test("classic fee thresholds clamp cheap quotes and give quadratic stake/fee weights", () => {
  assert.deepEqual(classicRelayerFeeBounds(1n), { minFee: 0.33, maxFee: 0.53 });
  assert.deepEqual(classicRelayerFeeBounds(11155111n), { minFee: 0.01, maxFee: 0.30 });
  const full = classicRelayerWeight(stake, 0.33, 1n);
  assert.ok(full > 0n);
  assert.equal(classicRelayerWeight(stake, 0.2, 1n), full);
  assert.equal(classicRelayerWeight(stake, 0, 1n), full);
  assert.equal(classicRelayerWeight(stake, 0.43, 1n) * 4n, full * 3n);
  assert.equal(classicRelayerWeight(stake * 2n, 0.43, 1n), classicRelayerWeight(stake, 0.43, 1n) * 2n);
  assert.ok(classicRelayerWeight(stake, 0.529999, 1n) > 0n);
  assert.equal(classicRelayerWeight(stake, 0.53, 1n), 0n);
  assert.equal(classicRelayerWeight(stake - 1n, 0.33, 1n), 0n);
  assert.equal(classicRelayerWeight(stake, 0.3, 11155111n), 0n);
  for (const badFee of [NaN, Infinity, -1]) assert.equal(classicRelayerWeight(stake, badFee, 1n), 0n);
});

test("weighted draws include expensive quotes and preserve exact cumulative boundaries", () => {
  const low = { name: "cheap", stakeBalance: stake, tornadoServiceFee: 0.2 };
  const high = { name: "higher", stakeBalance: stake, tornadoServiceFee: 0.43 };
  const ineligible = { name: "excluded", stakeBalance: stake - 1n, tornadoServiceFee: 0.1 };
  const firstWeight = classicRelayerWeight(stake, 0.2, 1n);
  assert.equal(pickClassicRelayer([ineligible, low, high], 1n, () => 0n), low);
  assert.equal(pickClassicRelayer([low, high], 1n, () => firstWeight - 1n), low);
  assert.equal(pickClassicRelayer([low, high], 1n, () => firstWeight), high);
  assert.equal(pickClassicRelayer([low, high], 1n, (total) => total - 1n), high);
  assert.throws(() => pickClassicRelayer([ineligible], 1n), /500 TORN/);
  assert.throws(() => pickClassicRelayer([low], 1n, total => total), /Invalid weighted/);
});

test("classic network fee uses base fee plus at least 3 gwei of priority", () => {
  assert.equal(classicRelayerGasPrice(220_000_000n, 10_000_000n) * 550_000n, 1_771_000_000_000_000n);
  assert.equal(classicRelayerGasPrice(220_000_000n, 4_000_000_000n), 4_220_000_000n);
  assert.throws(() => classicRelayerGasPrice(-1n, 0n), /Invalid/);
});

function fixture() {
  const entries = ["cheap", "higher", "unstaked", "old-owner", "old-host", "wrong-reward"].map((name, index) => ({
    ensName: `${name}.eth`, hostname: `${name}.example`, relayerAddress: BigInt(100 + index), stakeBalance: stake,
  }));
  const seen = { urls: [] as string[], rpc: [] as string[], aggregator: 0 };
  const snapshot = JSON.stringify({ relayers: { relayersTuples: entries.map(entry => [entry.ensName,
    { ...entry, relayerAddress: toHex(entry.relayerAddress), stakeBalance: toHex(stake) }]) } });
  const host = {
    storage: { get: async (key: string) => {
      assert.equal(key, `tornado-cash-state-1-${TornadoCashConfigs[1].instanceRegistry.address}`);
      return snapshot;
    } },
    provider: { request: async ({ method, params }: { method: string; params: any[] }) => {
      seen.rpc.push(method);
      if (method === "eth_getBlockByNumber") return { baseFeePerGas: toHex(220_000_000n) };
      if (method === "eth_maxPriorityFeePerGas") return toHex(10_000_000n);
      if (method === "eth_gasPrice") return "0x7";
      assert.equal(method, "eth_call"); seen.aggregator++;
      assert.equal(params[0].to.toLowerCase(), toHex(TornadoCashConfigs[1].aggregator.address, { size: 20 }).toLowerCase());
      const decoded = decodeFunctionData({ abi: aggregatorAbi, data: params[0].data });
      return encodeFunctionResult({ abi: aggregatorAbi, functionName: "relayersData", result: decoded.args[0].map((hash) => {
        const entry = entries.find(entry => namehash(entry.ensName) === hash)!;
        const records = Array.from({ length: 20 }, (_, index) => index === 0 ? entry.hostname : "");
        if (entry.ensName === "old-host.eth") records[0] = "new-host.example";
        return { owner: toHex(entry.ensName === "old-owner.eth" ? 777n : entry.relayerAddress, { size: 20 }),
          balance: entry.ensName === "unstaked.eth" ? stake - 1n : stake, isRegistered: true, records: records as unknown as TextRecords };
      }) });
    } },
    network: { fetch: async (input: string, options: RequestInit) => {
      seen.urls.push(input); assert.equal(options.redirect, "error");
      const entry = entries.find(entry => input === `https://${entry.hostname}/status`)!;
      return Response.json({ netId: 1, currentQueue: 0, version: "5.0.0",
        rewardAccount: toHex(entry.ensName === "wrong-reward.eth" ? 999n : entry.relayerAddress, { size: 20 }),
        tornadoServiceFee: entry.ensName === "higher.eth" ? 0.43 : 0.2, ethPrices: {},
      });
    } },
  } as unknown as Host;
  registerPrivateEnsRpc(host.provider, "https://relayer-ens-rpc.invalid/rpc");
  const run = <T>(operation: () => Promise<T>) => withFakeTor(async (url, init) => {
    assert.equal(url, "https://relayer-ens-rpc.invalid/rpc");
    const request = JSON.parse(String(init?.body));
    assert.equal(request.method, "eth_call");
    return Response.json({ jsonrpc: "2.0", id: request.id, result: await host.provider.request(request) });
  }, operation);
  return { host, entries, seen, run };
}

test("CLI status hook refreshes stake/owner/hostname, draws once, and defeats SDK cheapest ranking", async () => {
  const { host, seen, entries, run } = fixture();
  let draws = 0;
  const policy = createClassicRelayerPolicy(host, 1n, (total) => { draws++; return total - 1n; });
  const client = policy.relayerClientFactory();
  const outcomes = await run(() => policy.prepare(asset, { mode: "relayer" }, async () => {
    assert.equal(await policy.host.provider.request({ method: "eth_gasPrice", params: [] }), toHex(3_220_000_000n));
    return Promise.allSettled(entries.map(entry => client.getStatus(entry.hostname)));
  }));
  assert.equal(draws, 1);
  assert.equal(seen.aggregator, 1);
  assert.deepEqual(outcomes.map((outcome, index) => outcome.status === "fulfilled" ? entries[index]!.ensName : null).filter(Boolean), ["higher.eth"]);
  assert.ok(!seen.urls.some(url => /unstaked|old-owner|old-host/.test(url)), "stale registry entries are filtered before status requests");
  assert.ok(seen.urls.includes("https://wrong-reward.example/status"));
  assert.equal(await policy.host.provider.request({ method: "eth_gasPrice", params: [] }), "0x7");
  await assert.rejects(client.getStatus("higher.example"), /outside explicit/);
});

test("fee policy resets after failures and serializes overlapping paymaster preparation", async () => {
  const { host, seen } = fixture();
  const policy = createClassicRelayerPolicy(host, 1n);
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const relayer = policy.prepare(asset, { mode: "relayer" }, async () => {
    assert.equal(seen.rpc.length, 0, "do not freeze fee-market inputs before the SDK completes its sync");
    assert.equal(await policy.host.provider.request({ method: "eth_gasPrice", params: [] }), toHex(3_220_000_000n));
    entered(); await blocked; throw new Error("proving stopped");
  });
  await started;
  let paymasterStarted = false;
  const paymaster = policy.prepare(asset, { mode: "paymaster" }, async () => {
    paymasterStarted = true;
    assert.equal(await policy.host.provider.request({ method: "eth_gasPrice", params: [] }), "0x7");
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(paymasterStarted, false);
  release();
  await assert.rejects(relayer, /proving stopped/);
  await paymaster;
  assert.equal(seen.rpc.filter(method => method === "eth_getBlockByNumber").length, 1);
});

test("omitted prepare options retain the SDK's default relayer mode", async () => {
  const { host, run } = fixture();
  const policy = createClassicRelayerPolicy(host, 1n, () => 0n);
  await run(() => policy.prepare(asset, undefined, async () => {
    assert.equal(await policy.host.provider.request({ method: "eth_gasPrice", params: [] }), toHex(3_220_000_000n));
    assert.equal((await policy.relayerClientFactory().getStatus("cheap.example")).tornadoServiceFee, 0.2);
  }));
});

test("ENS lookup without RPC context or an active preparation fails closed", async () => {
  const { host, seen } = fixture();
  const request = { method: "eth_call", params: [{
    to: toHex(TornadoCashConfigs[1].aggregator.address, { size: 20 }), data: "0x4d47d775",
  }, "latest"] };
  const providerWithoutContext = { ...host.provider };
  const policy = createClassicRelayerPolicy({ ...host, provider: providerWithoutContext }, 1n);
  await assert.rejects(policy.host.provider.request(request), /outside a protected preparation/);
  await assert.rejects(policy.prepare(asset, { mode: "relayer" }, () => policy.host.provider.request(request)),
    /missing its configured RPC endpoint/);
  const sepolia = createClassicRelayerPolicy({ ...host, provider: providerWithoutContext }, 11155111n);
  await assert.rejects(sepolia.host.provider.request({ ...request, params: [{
    to: toHex(TornadoCashConfigs[11155111].aggregator.address), data: "0x4d47d775",
  }, "latest"] }), /outside a protected preparation/, "unpadded Sepolia address must not evade the guard");
  assert.deepEqual(seen.rpc, [], "missing metadata must not fall back to the ordinary provider");
});

test("installed Tornado worker honors the status hook and classic fee bridge before proving", async () => {
  const file = fileURLToPath(new URL("./fixtures/tornado-classic-relayer-policy.ts", import.meta.url));
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", file], { env });
    let output = "";
    child.stdout.on("data", chunk => { output += chunk; });
    child.stderr.on("data", chunk => { output += chunk; });
    const timeout = setTimeout(() => { child.kill(); reject(new Error(`Classic relayer SDK regression timed out: ${output}`)); }, 30_000);
    child.on("error", error => { clearTimeout(timeout); reject(error); });
    child.on("close", code => { clearTimeout(timeout); resolve({ code, output }); });
  });
  assert.equal(result.code, 0, result.output);
});
