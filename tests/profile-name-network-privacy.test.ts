import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeErrorResult,
  offchainLookupAbiItem,
  parseAbi,
  toFunctionSelector,
  type Hex,
} from "viem";
import { mainnet } from "viem/chains";
import { STEALTH_REGISTRY_ADDRESS } from "eth-stealth-address-resolver";
import { resolveWalletProfile } from "../src/commands/balances.js";
import { readProfileNameRecords } from "../src/commands/init-profile.js";
import { makeStealthAccountsStorage } from "../src/lib/stealth/storage.js";
import { makePublicAccountsStorage } from "../src/utils/public-accounts.js";
import { withFakeTor } from "./helpers/fake-tor.js";

const mnemonic = "test test test test test test test test test test test junk";
const rpcUrl = "https://profile-rpc.invalid/rpc";
// Gateway requests must not inherit this RPC hostname's clearnet exemption.
const gateway = "https://profile-rpc.invalid/gateway/{data}";
const resolver = mainnet.contracts.ensUniversalResolver.address;
const name = "alice.eth";
const meta = `st:eth:0x${"02".repeat(66)}`;
const universalAbi = parseAbi([
  "function reverseWithGateways(bytes reverseName, uint256 coinType, string[] gateways) view returns (string,address,address)",
  "function resolveWithGateways(bytes name, bytes data, string[] gateways) view returns (bytes,address)",
]);
const callbacks = { reverse: "0x12345671", forward: "0x12345672", text: "0x12345673", registry: "0x12345674" } as const;
const lookupData = { reverse: "0x01", forward: "0x02", text: "0x03", registry: "0x04" } as const;
type Lookup = keyof typeof callbacks;

it("protects balances discovery and init-profile reverse, forward and text callbacks, preserving cache and opt-outs", async () => {
  const walletDir = mkdtempSync(join(tmpdir(), "kohaku-profile-privacy-"));
  const password = "password";
  const accounts = makePublicAccountsStorage(walletDir, mnemonic, password);
  accounts.addNextAccounts(1);
  const account = accounts.getAccount(0)!.address as `0x${string}`;
  const profileOpts = { rpcUrl, walletDir, mnemonic, password, chainId: 1n, resyncProfile: true };
  const recordsOpts = { rpcUrl, walletDir, name, address: account };
  const originalFetch = globalThis.fetch;
  const originalWithoutTor = process.env.KOHAKU_WITHOUT_TOR;
  delete process.env.KOHAKU_WITHOUT_TOR;
  let failGateway = false;
  let failBootstrap = false;
  let noReverse = false;
  let ready = false;
  let bootstraps = 0;
  const directUrls: string[] = [];
  const torLookups: Lookup[] = [];
  const gatewayResponse = () => failGateway
    ? new Response("fixture gateway unavailable", { status: 503 })
    : Response.json({ data: "0x1234" });
  const resultFor = (lookup: Lookup) => lookup === "registry"
    ? encodeAbiParameters([{ type: "bytes" }], [meta.slice(7) as Hex])
    : lookup === "reverse"
    ? encodeAbiParameters([{ type: "string" }, { type: "address" }, { type: "address" }], [noReverse ? "" : name, resolver, resolver])
    : encodeAbiParameters([{ type: "bytes" }, { type: "address" }], [
        lookup === "text"
          ? encodeAbiParameters([{ type: "string" }], [meta])
          : encodeAbiParameters([{ type: "address" }], [account]),
        resolver,
      ]);
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    directUrls.push(url);
    if (url.includes("/gateway/")) return gatewayResponse();
    assert.equal(url, rpcUrl);
    assert.ok(ready || process.env.KOHAKU_WITHOUT_TOR === "1" || allowDirect,
      "Tor must be ready before profile network discovery starts");
    const body = JSON.parse(String(init?.body));
    const reply = (request: { id: number; method: string; params: [{ to: string; data: Hex }] }) => {
      assert.equal(request.method, "eth_call");
      const call = request.params[0];
      const callback = (Object.keys(callbacks) as Lookup[]).find((kind) => call.data.startsWith(callbacks[kind]));
      if (callback) return { jsonrpc: "2.0", id: request.id, result: resultFor(callback) };
      const registryLookup = call.to.toLowerCase() === STEALTH_REGISTRY_ADDRESS.toLowerCase();
      if (call.to.toLowerCase() !== resolver.toLowerCase() && !registryLookup) {
        // GNS/WNS have no primary name for this wallet in the fixture.
        return { jsonrpc: "2.0", id: request.id,
          result: encodeAbiParameters([{ type: "string" }], [""]) };
      }
      const decoded = registryLookup ? undefined : decodeFunctionData({ abi: universalAbi, data: call.data });
      const kind: Lookup = registryLookup ? "registry" : decoded!.functionName === "reverseWithGateways"
        ? "reverse"
        : String(decoded!.args[1]).startsWith(toFunctionSelector("text(bytes32,string)")) ? "text" : "forward";
      return { jsonrpc: "2.0", id: request.id, error: { code: 3, message: "execution reverted", data:
        encodeErrorResult({ abi: [offchainLookupAbiItem], errorName: "OffchainLookup",
          args: [call.to as `0x${string}`, [gateway], lookupData[kind], callbacks[kind], "0x"] }) } };
    };
    return Response.json(Array.isArray(body) ? body.map(reply) : reply(body));
  };
  let allowDirect = false;
  try {
    await withFakeTor(async (url) => {
      assert.ok(ready, "offchain profile callbacks must execute in a ready Tor session");
      const kind = (Object.keys(lookupData) as Lookup[]).find((lookup) => url.endsWith(lookupData[lookup]));
      assert.ok(kind, `Unexpected offchain request: ${url}`);
      torLookups.push(kind);
      return gatewayResponse();
    }, async () => {
      const storage = makeStealthAccountsStorage(walletDir, password);
      storage.setProfile({ name, index: 0, address: account, stealthMetaAddressURI: meta });
      const cached = await resolveWalletProfile({ ...profileOpts, resyncProfile: false });
      assert.equal(cached.name, name);
      assert.equal(bootstraps, 0, "cached profiles must not start Tor");
      assert.equal(directUrls.length, 0);

      const profile = await resolveWalletProfile(profileOpts);
      assert.equal(profile.name, name);
      assert.equal(profile.stealthMetaAddressURI, meta);
      assert.equal(profile.needsInit, false);
      assert.deepEqual(torLookups, ["reverse", "forward", "text"]);
      assert.ok(directUrls.every((url) => url === rpcUrl));
      const cachedBootstrapCount = bootstraps;
      const cachedRequestCount = directUrls.length;
      await resolveWalletProfile({ ...profileOpts, resyncProfile: false });
      assert.equal(bootstraps, cachedBootstrapCount);
      assert.equal(directUrls.length, cachedRequestCount);

      noReverse = true;
      torLookups.length = 0;
      const registryProfile = await resolveWalletProfile(profileOpts);
      assert.equal(registryProfile.name, account);
      assert.equal(registryProfile.stealthMetaAddressURI, meta);
      assert.deepEqual(torLookups, ["reverse", "registry"],
        "stealth registry callbacks must use the protected client as well as protected names");
      noReverse = false;

      torLookups.length = 0;
      const existing = await readProfileNameRecords(recordsOpts);
      assert.equal(existing.primaries?.ens, name);
      assert.equal(existing.text, meta);
      assert.deepEqual(torLookups, ["reverse", "forward", "text"]);
      torLookups.length = 0;
      // Post-publish verification starts a fresh safe scope, without reverse discovery.
      const published = await readProfileNameRecords({ ...recordsOpts, address: undefined });
      assert.equal(published.text, meta);
      assert.deepEqual(torLookups, ["text"]);

      failGateway = true;
      const missing = await resolveWalletProfile(profileOpts);
      assert.equal(missing.needsInit, true);
      assert.equal(makeStealthAccountsStorage(walletDir, password).getStore().profile, null,
        "failed explicit resync must keep the existing cleared-profile semantics");
      assert.ok(directUrls.every((url) => url === rpcUrl), "failed gateways must never retry over clearnet");
      failGateway = false;

      const beforeOptOut = bootstraps;
      const torCount = torLookups.length;
      allowDirect = true;
      assert.equal((await resolveWalletProfile({ ...profileOpts, withoutTor: true })).name, name);
      assert.equal((await readProfileNameRecords({ ...recordsOpts, withoutTor: true })).text, meta);
      assert.equal(bootstraps, beforeOptOut);
      assert.equal(torLookups.length, torCount);
      assert.ok(directUrls.some((url) => url.includes("/gateway/")));
      allowDirect = false;

      process.env.KOHAKU_WITHOUT_TOR = "1";
      assert.equal((await resolveWalletProfile(profileOpts)).name, name);
      assert.equal((await readProfileNameRecords(recordsOpts)).text, meta);
      assert.equal(bootstraps, beforeOptOut);
      assert.equal(torLookups.length, torCount);
      delete process.env.KOHAKU_WITHOUT_TOR;

      const beforeFailure = directUrls.length;
      ready = false;
      failBootstrap = true;
      await assert.rejects(readProfileNameRecords(recordsOpts), /fixture bootstrap failure/);
      await assert.rejects(resolveWalletProfile(profileOpts), /fixture bootstrap failure/);
      assert.equal(directUrls.length, beforeFailure, "bootstrap failure must prevent all profile requests");
      assert.ok(makeStealthAccountsStorage(walletDir, password).getStore().profile,
        "Tor bootstrap failure must not erase a previously discovered profile");
    }, async () => {
      bootstraps++;
      if (failBootstrap) throw new Error("fixture bootstrap failure");
      ready = true;
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalWithoutTor === undefined) delete process.env.KOHAKU_WITHOUT_TOR;
    else process.env.KOHAKU_WITHOUT_TOR = originalWithoutTor;
    rmSync(walletDir, { recursive: true, force: true });
  }
});
