// Child process: the published SDK has no public worker-disposal API.
import assert from "node:assert/strict";
import type { Host } from "@kohaku-eth/plugins";
import { computeMimcMerkleTreeRoot } from "@kohaku-eth/mimc-tree";
import { createTCPlugin, SignatureSecretManager, TornadoCashConfigs, TornadoInstances } from "@kohaku-eth/tornado-cash";
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, encodeFunctionResult, parseAbi, toHex, type ContractFunctionReturnType } from "viem";
import { namehash } from "viem/ens";
import { createClassicRelayerPolicy, CLASSIC_RELAYER_MIN_STAKE } from "../../src/utils/tornado-classic-relayer-policy.js";
import { registerPrivateEnsRpc } from "../../src/host/private-ens-rpc.js";
import { withTor } from "../../src/utils/tor.js";
import { withFakeTor } from "../helpers/fake-tor.js";

async function main() {
  const chainId = 1n;
  const pool = TornadoInstances[1].find(pool => pool.asset === 0n && pool.denomination === 10n ** 17n)!;
  const config = { ...TornadoCashConfigs[1], instances: [pool] };
  const keystore = { deriveAt: async () => `0x${"12".repeat(32)}` as `0x${string}` };
  const manager = await SignatureSecretManager({ host: { keystore } as never, accountIndex: 0 });
  const secret = await manager.getSignatureSecrets({ chainId, poolAddress: pool.address, nonce: 0 });
  const root = computeMimcMerkleTreeRoot([secret.commitment]);
  const head = 10_000n;
  const finalized = 9_900n;
  const depositBlock = 3_000n;
  const relayers = ["cheap", "higher"].map((name, index) => ({
    ensName: `${name}.eth`, hostname: `${name}.example`, relayerAddress: toHex(BigInt(index + 100)),
    stakeBalance: toHex(CLASSIC_RELAYER_MIN_STAKE),
  }));
  const state = {
    pools: { poolsTuples: [[toHex(pool.address), {
      address: toHex(pool.address), asset: "0x0", isERC20: false, denomination: toHex(pool.denomination),
      protocolFeePercentage: 0, registeredBlock: "0x1", lastSyncedBlock: toHex(head), state: 1, rootHistorySize: 100,
    }]] },
    deposits: { depositsTuples: [[toHex(pool.address), [[toHex(secret.commitment), {
      pool: toHex(pool.address), commitment: toHex(secret.commitment), leafIndex: 0,
      timestamp: "0x1", blockNumber: toHex(depositBlock), transactionHash: "0x1",
    }]]]] },
    withdrawals: { withdrawalsTuples: [] },
    assets: { assetsTuples: [["0x0", { address: "0x0", name: "Ether", symbol: "ETH", decimals: 18 }]] },
    relayers: { relayersTuples: relayers.map(relayer => [relayer.ensName, relayer]) },
    sync: { lastSyncedBlock: toHex(head), relayerRegistrySyncedBlock: toHex(finalized - 1n) },
  };
  const key = `tornado-cash-state-${chainId}-${config.instanceRegistry.address}`;
  const storage = new Map([[key, JSON.stringify(state)]]);
  const abi = parseAbi([
    "function getAllInstanceAddresses() view returns (address[])",
    "function getLastRoot() view returns (bytes32)",
    "function nextIndex() view returns (uint32)",
    "function relayersData(bytes32[] _relayers, string[] _subdomains) view returns ((address owner, uint256 balance, bool isRegistered, string[20] records)[])",
  ]);
  type TextRecords = ContractFunctionReturnType<typeof abi, "view", "relayersData">[number]["records"];
  let baseFee = 220_000_000n;
  let persisted = 0;
  let selections = 0;
  let proofs = 0;
  let servingPrivateRpc = false;
  let sdkEnsCalls = 0;
  const statusHosts: string[] = [];
  const rawGasPrice = toHex(220_000_000n);
  const host = {
    keystore,
    storage: { _brand: "Storage", get: async (key: string) => storage.get(key) ?? null,
      set: async (key: string, value: string) => { persisted++; storage.set(key, value); } },
    provider: {
      getChainId: async () => chainId,
      getBlockNumber: async () => head,
      getLogs: async ({ address, fromBlock, toBlock }: { address: string; fromBlock: bigint; toBlock: bigint }) =>
        BigInt(address) === pool.address && fromBlock <= depositBlock && toBlock >= depositBlock ? [{
          address, blockNumber: depositBlock,
          data: encodeAbiParameters([{ type: "uint32" }, { type: "uint256" }], [0, 1n]),
          topics: encodeEventTopics({ abi: parseAbi(["event Deposit(bytes32 indexed commitment, uint32 leafIndex, uint256 timestamp)"]),
            eventName: "Deposit", args: { commitment: toHex(secret.commitment, { size: 32 }) } }),
        }] : BigInt(address) === config.relayerRegistry.address && fromBlock <= finalized && toBlock >= finalized ? [{
          address, blockNumber: finalized, transactionHash: toHex(1n, { size: 32 }),
          topics: encodeEventTopics({ abi: parseAbi(["event RelayerRegistered(bytes32 relayer, string ensName, address relayerAddress, uint256 stakedAmount)"]), eventName: "RelayerRegistered" }),
          data: encodeAbiParameters([{ type: "bytes32" }, { type: "string" }, { type: "address" }, { type: "uint256" }],
            [namehash(relayers[0]!.ensName), relayers[0]!.ensName, toHex(BigInt(relayers[0]!.relayerAddress), { size: 20 }), CLASSIC_RELAYER_MIN_STAKE]),
        }] : [],
      request: async ({ method, params }: { method: string; params: any[] }) => {
        if (method === "eth_chainId") return toHex(chainId);
        if (method === "eth_blockNumber") return toHex(head);
        if (method === "eth_getBlockByNumber") return params[0] === "latest"
          ? { number: toHex(head), baseFeePerGas: toHex(baseFee) } : { number: toHex(finalized) };
        if (method === "eth_maxPriorityFeePerGas") return toHex(10_000_000n);
        if (method === "eth_gasPrice") return rawGasPrice;
        assert.equal(method, "eth_call");
        const decoded = decodeFunctionData({ abi, data: params[0].data });
        if (decoded.functionName === "relayersData") {
          assert.ok(servingPrivateRpc, "SDK and CLI ENS lookups must not use the ordinary read RPC transport");
          if (persisted < 2) sdkEnsCalls++;
          return encodeFunctionResult({ abi, functionName: "relayersData", result: decoded.args[0].map(hash => {
            const relayer = relayers.find(relayer => namehash(relayer.ensName) === hash)!;
            return { owner: toHex(BigInt(relayer.relayerAddress), { size: 20 }), balance: CLASSIC_RELAYER_MIN_STAKE, isRegistered: true,
              records: Array.from({ length: 20 }, (_, index) => index === 0 ? relayer.hostname : "") as unknown as TextRecords };
          }) });
        }
        if (decoded.functionName === "getAllInstanceAddresses") return encodeAbiParameters([{ type: "address[]" }], [[toHex(pool.address, { size: 20 })]]);
        if (decoded.functionName === "nextIndex") return encodeAbiParameters([{ type: "uint32" }], [1]);
        assert.equal(decoded.functionName, "getLastRoot");
        return encodeAbiParameters([{ type: "bytes32" }], [toHex(root, { size: 32 })]);
      },
    },
    network: { fetch: async (url: string, options: RequestInit) => {
      statusHosts.push(url); assert.equal(options.redirect, "error");
      const index = url.includes("higher") ? 1 : 0;
      return Response.json({ netId: 1, currentQueue: 0, version: "5.0.0", ethPrices: {},
        rewardAccount: toHex(BigInt(relayers[index]!.relayerAddress), { size: 20 }), tornadoServiceFee: index === 0 ? 0.2 : 0.43 });
    } },
  } as unknown as Host;
  const rpcUrl = "https://relayer-ens-rpc.invalid/rpc";
  registerPrivateEnsRpc(host.provider, rpcUrl);
  let torRequests = 0;
  let directRequests = 0;
  let allowDirect = false;
  let failTor = false;
  const originalFetch = globalThis.fetch;
  const originalWithoutTor = process.env.KOHAKU_WITHOUT_TOR;
  delete process.env.KOHAKU_WITHOUT_TOR;
  const reply = async (url: string, init?: { body?: unknown }) => {
    assert.equal(url, rpcUrl);
    const request = JSON.parse(String(init?.body));
    servingPrivateRpc = true;
    try {
      return Response.json({ jsonrpc: "2.0", id: request.id, result: await host.provider.request(request) });
    } finally { servingPrivateRpc = false; }
  };
  globalThis.fetch = async (input, init) => {
    assert.ok(allowDirect, "ENS lookups must not leave on clearnet without an explicit opt-out");
    directRequests++;
    return reply(String(input), init);
  };
  try {
  await withFakeTor(async (url, init) => {
    torRequests++;
    if (failTor) throw new Error("FIXTURE_TOR_FAILURE");
    return reply(url, init);
  }, async () => {
  const policy = createClassicRelayerPolicy(host, chainId, total => { selections++; return total - 1n; });
  const accepted: string[] = [];
  const workerGasPrices: unknown[] = [];
  const client = policy.relayerClientFactory();
  const workerHost = { ...policy.host, provider: new Proxy(policy.host.provider, {
    get(target, property) {
      if (property === "request") return async (request: Parameters<Host["provider"]["request"]>[0]) => {
        const result = await target.request(request);
        if (request.method === "eth_gasPrice") workerGasPrices.push(result);
        return result;
      };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) };
  const plugin = createTCPlugin(workerHost, { accountIndex: 0, protocolConfig: config,
    relayerConfig: policy.relayerConfig,
    relayerClientFactory: () => ({ ...client, getStatus: async hostname => {
      const status = await client.getStatus(hostname); accepted.push(hostname); return status;
    } }),
    secretManagerFactory: async () => ({ ...manager,
      getLegacyDepositSecrets: async () => ({ commitment: 1n, nullifierHash: 1n, nullifier: 1n, salt: 1n }),
    }) as never,
    artifactsLoader: async () => { proofs++; throw new Error("FIXTURE_PROOF_BOUNDARY"); },
  });
  const asset = { asset: { __type: "erc20" as const, contract: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" as const }, amount: pool.denomination };
  const recipient = toHex(999n, { size: 20 });
  await assert.rejects(withTor(true, { rpcUrl }, () => policy.prepare(asset, { mode: "relayer" }, () => plugin.prepareUnshield(asset, recipient, { mode: "relayer" }))), error => {
    assert.match(String((error as { message?: string })?.message), /FIXTURE_PROOF_BOUNDARY/); return true;
  });
  assert.equal(proofs, 1, "native quote validates the policy result before loading proof artifacts");
  assert.equal(selections, 1);
  assert.deepEqual(workerGasPrices, [toHex(3_220_000_000n)], "SDK worker receives the frozen classic gas price through its Host bridge");
  assert.deepEqual(accepted, ["higher.example"], "native cheapest ranking receives only the weighted, more expensive winner");
  assert.deepEqual(statusHosts.sort(), ["https://cheap.example/status", "https://higher.example/status"]);
  assert.equal(await policy.host.provider.request({ method: "eth_gasPrice", params: [] }), rawGasPrice);
  assert.ok(sdkEnsCalls > 0, "the published SDK's own registry lookup crosses the protected Host bridge");
  assert.equal(torRequests, 2, "both SDK registry sync and CLI fresh metadata lookups use Tor");
  assert.equal(directRequests, 0);

  // The worker loses the caller's async context. Capturing it at prepare keeps
  // both explicit CLI opt-outs and default Tor routing across Comlink.
  const prepare = () => policy.prepare(asset, { mode: "relayer" }, () => plugin.prepareUnshield(asset, recipient, { mode: "relayer" }));
  allowDirect = true;
  const beforeOptOutTor = torRequests;
  await assert.rejects(withTor(false, { rpcUrl }, prepare), error => {
    assert.match(String((error as { message?: string })?.message), /FIXTURE_PROOF_BOUNDARY/); return true;
  });
  assert.equal(torRequests, beforeOptOutTor);
  assert.equal(directRequests, 1);
  process.env.KOHAKU_WITHOUT_TOR = "1";
  await assert.rejects(prepare(), error => {
    assert.match(String((error as { message?: string })?.message), /FIXTURE_PROOF_BOUNDARY/); return true;
  });
  assert.equal(torRequests, beforeOptOutTor);
  assert.equal(directRequests, 2);
  delete process.env.KOHAKU_WITHOUT_TOR;
  allowDirect = false;
  const proofsBeforeFailure = proofs;
  failTor = true;
  await assert.rejects(prepare(), error => {
    assert.match(String((error as { message?: string })?.message), /FIXTURE_TOR_FAILURE/); return true;
  });
  assert.equal(directRequests, 2, "Tor errors never fall back to the ordinary RPC transport");
  assert.equal(proofs, proofsBeforeFailure);
  failTor = false;

  // At ~34 gwei the floor moves this 0.1 ETH note above the SDK's 20% cap.
  // Without the worker-visible override the raw 0.22 gwei quote would pass.
  baseFee = 34_000_000_000n;
  await assert.rejects(policy.prepare(asset, { mode: "relayer" }, () => plugin.prepareUnshield(asset, recipient, { mode: "relayer" })), error => {
    assert.match(String((error as { message?: string })?.message), /500 TORN|fee limits|liveness/); return true;
  });
  assert.equal(proofs, proofsBeforeFailure, "unsafe high-network-fee quote is rejected before proof generation");
  assert.equal(workerGasPrices.at(-1), toHex(37_000_000_000n));
  assert.equal(await policy.host.provider.request({ method: "eth_gasPrice", params: [] }), rawGasPrice);
  });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalWithoutTor === undefined) delete process.env.KOHAKU_WITHOUT_TOR;
    else process.env.KOHAKU_WITHOUT_TOR = originalWithoutTor;
  }
}

main().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
