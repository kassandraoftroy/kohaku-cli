import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { Command } from "commander";
import { encodeAbiParameters, encodeErrorResult, offchainLookupAbiItem } from "viem";
import { mainnet } from "viem/chains";
import { runUnshield } from "../src/commands/unshield.js";
import { runPrivateTransfer } from "../src/commands/private-transfer.js";
import { registerTransferCommand } from "../src/commands/transfer.js";
import { maybeResolveName, resolveAddressOrName } from "../src/utils/resolve-name.js";
import { withTor } from "../src/utils/tor.js";
import { writeSeedKeystore } from "../src/utils/mnemonic.js";
import { makePublicAccountsStorage } from "../src/utils/public-accounts.js";
import { writeWalletType } from "../src/utils/wallets-util.js";
import { withFakeTor } from "./helpers/fake-tor.js";

const mnemonic = "test test test test test test test test test test test junk";
const rpcUrl = "https://read-rpc.invalid/rpc";
// Sharing a hostname must not cause a CCIP gateway to inherit the RPC bypass.
const gateway = "https://read-rpc.invalid/gateway/{data}";
const recipient = "0x1111111111111111111111111111111111111111";
const resolver = mainnet.contracts.ensUniversalResolver.address;

it("routes ENS RPC, CCIP and callbacks over Tor in standalone and all three transfer flows", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "kohaku-name-privacy-"));
  const walletDir = join(dataDir, "test");
  writeSeedKeystore(mnemonic, "password", walletDir);
  writeWalletType("mainnet", walletDir);
  makePublicAccountsStorage(walletDir, mnemonic, "password").addNextAccounts(1);
  const originalFetch = globalThis.fetch;
  const originalExit = process.exitCode;
  const originalWithoutTor = process.env.KOHAKU_WITHOUT_TOR;
  delete process.env.KOHAKU_WITHOUT_TOR;
  let failGateway = false;
  let onchainOnly = false;
  let failBootstrap = false;
  let allowDirect = false;
  const directUrls: string[] = [];
  const torUrls: string[] = [];
  const directLookupCalls: string[] = [];
  const torLookupCalls: string[] = [];
  let bootstraps = 0;
  const gatewayResponse = () => failGateway
    ? new Response("fixture gateway unavailable", { status: 503 })
    : Response.json({ data: "0x1234" });
  const rpcResponse = (bodyText: unknown, viaTor: boolean) => {
    const body = JSON.parse(String(bodyText));
    const reply = (request: { id: number; method: string; params?: any[] }) => {
      let result: unknown = "0x0";
      if (request.method === "eth_chainId") result = "0x1";
      else if (request.method === "eth_getBalance") result = "0xde0b6b3a7640000";
      else if (request.method === "eth_getCode") result = "0x";
      else if (request.method === "eth_call") {
        (viaTor ? torLookupCalls : directLookupCalls).push(request.method);
        assert.ok(viaTor || allowDirect || process.env.KOHAKU_WITHOUT_TOR === "1",
          "ENS contract calls must never inherit the read RPC's clearnet exemption");
        const call = request.params![0];
        if (onchainOnly || call.data.startsWith("0x12345678")) {
          result = encodeAbiParameters([{ type: "bytes" }, { type: "address" }], [
            encodeAbiParameters([{ type: "address" }], [recipient]), resolver,
          ]);
        } else {
          return { jsonrpc: "2.0", id: request.id, error: { code: 3, message: "execution reverted", data:
            encodeErrorResult({ abi: [offchainLookupAbiItem], errorName: "OffchainLookup",
              args: [call.to, [gateway], "0x0102", "0x12345678", "0x"] }) } };
        }
      } else {
        assert.fail(`Unexpected RPC request ${request.method}`);
      }
      return { jsonrpc: "2.0", id: request.id, result };
    };
    return Response.json(Array.isArray(body) ? body.map(reply) : reply(body));
  };
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    directUrls.push(url);
    if (url.includes("/gateway/")) {
      assert.ok(allowDirect || process.env.KOHAKU_WITHOUT_TOR === "1", "CCIP must require an explicit Tor opt-out");
      return gatewayResponse();
    }
    assert.equal(url, rpcUrl);
    return rpcResponse(init?.body, false);
  };
  try {
    await withFakeTor(async (url, init) => {
      assert.ok(bootstraps > 0, "Tor must be ready before any name lookup");
      torUrls.push(url);
      if (url === rpcUrl) return rpcResponse(init?.body, true);
      assert.equal(url, "https://read-rpc.invalid/gateway/0x0102");
      return gatewayResponse();
    }, async () => {
      assert.equal(await resolveAddressOrName(recipient, rpcUrl), recipient);
      assert.equal(bootstraps, 0, "plain addresses need no Tor session or lookup");
      // No outer scope: the resolver itself must protect the complete exchange.
      assert.equal(await resolveAddressOrName("alice.eth", rpcUrl), recipient);
      assert.ok(bootstraps > 0, "standalone resolution must start Tor before its first request");
      assert.deepEqual(torUrls, [rpcUrl, "https://read-rpc.invalid/gateway/0x0102", rpcUrl]);
      assert.equal(directUrls.length, 0);
      assert.equal(torLookupCalls.length, 2, "the initial ENS RPC and CCIP callback must both use Tor");
      const beforeMaybe = bootstraps;
      assert.deepEqual(await maybeResolveName("alice.eth", rpcUrl), { address: recipient, resolvedFrom: "alice.eth" });
      assert.ok(bootstraps > beforeMaybe);
      await withTor(true, { rpcUrl }, async () => {
        assert.equal(await resolveAddressOrName("alice.eth", rpcUrl), recipient);
      });
      assert.equal(torLookupCalls.length, 6);
      assert.deepEqual(directLookupCalls, []);
      onchainOnly = true;
      const beforeOnchain = torUrls.length;
      assert.equal(await resolveAddressOrName("onchain.eth", rpcUrl), recipient);
      assert.deepEqual(torUrls.slice(beforeOnchain), [rpcUrl],
        "an ENS lookup without any offchain gateway must still use Tor");
      assert.deepEqual(directLookupCalls, []);
      onchainOnly = false;
      failGateway = true; // Stop each command after its real offchain lookup, before protocol preparation.
      const opts = { protocol: "tornado", wallet: "test", password: "password", dataDir,
        rpcUrl, nonInteractive: true, to: "alice.eth", amountFormatted: "0.1" };
      for (const run of [
        () => runUnshield(opts),
        () => runPrivateTransfer(opts),
        async () => {
          const command = new Command();
          registerTransferCommand(command);
          await command.parseAsync(["transfer", "--wallet", "test", "--password", "password",
            "--dataDir", dataDir, "--rpc-url", rpcUrl, "--non-interactive", "--from", "0",
            "--to", "alice.eth", "--amount-formatted", "0.1"], { from: "user" });
        },
      ]) {
        const before = torUrls.length;
        const callsBefore = torLookupCalls.length;
        await run();
        assert.ok(torUrls.length > before, "recipient name must use the active Tor session");
        assert.ok(torLookupCalls.length > callsBefore, "recipient ENS RPC must use Tor as well as its gateway");
        assert.equal(process.exitCode, 1, "failed offchain resolution must stop preparation");
        process.exitCode = originalExit;
      }
      assert.deepEqual(directLookupCalls, [], "lookup failures must not fall back to clearnet RPC");
      assert.ok(directUrls.every((url) => url === rpcUrl), "offchain failures must not fall back to clearnet");
      const before = torUrls.length;
      allowDirect = true;
      await runUnshield({ ...opts, withoutTor: true });
      assert.equal(torUrls.length, before, "explicit --without-tor must be respected");
      assert.ok(directLookupCalls.length > 0, "explicit opt-out must apply to ENS RPC too");
      assert.ok(directUrls.some((url) => url.includes("/gateway/")));
      process.exitCode = originalExit;
      allowDirect = false;
      failGateway = false;

      const optOutCalls = directLookupCalls.length;
      process.env.KOHAKU_WITHOUT_TOR = "1";
      assert.equal(await resolveAddressOrName("alice.eth", rpcUrl), recipient);
      assert.equal(torUrls.length, before);
      assert.equal(directLookupCalls.length, optOutCalls + 2);
      delete process.env.KOHAKU_WITHOUT_TOR;

      const directBeforeFailure = directUrls.length;
      const torBeforeFailure = torUrls.length;
      failBootstrap = true;
      await assert.rejects(resolveAddressOrName("alice.eth", rpcUrl), /fixture bootstrap failure/);
      assert.equal(directUrls.length, directBeforeFailure, "bootstrap failure must prevent all direct lookup attempts");
      assert.equal(torUrls.length, torBeforeFailure);
    }, async () => { bootstraps++; if (failBootstrap) throw new Error("fixture bootstrap failure"); });
  } finally {
    globalThis.fetch = originalFetch;
    process.exitCode = originalExit;
    if (originalWithoutTor === undefined) delete process.env.KOHAKU_WITHOUT_TOR;
    else process.env.KOHAKU_WITHOUT_TOR = originalWithoutTor;
    rmSync(dataDir, { recursive: true, force: true });
  }
});
