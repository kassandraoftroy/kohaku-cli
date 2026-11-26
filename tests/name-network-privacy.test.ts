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
import { resolveAddressOrName } from "../src/utils/resolve-name.js";
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

it("routes ENS CCIP over Tor before recipient resolution in all three transfer flows", async () => {
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
  const directUrls: string[] = [];
  const torUrls: string[] = [];
  let bootstraps = 0;
  const gatewayResponse = () => failGateway
    ? new Response("fixture gateway unavailable", { status: 503 })
    : Response.json({ data: "0x1234" });
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    directUrls.push(url);
    if (url.includes("/gateway/")) return gatewayResponse();
    assert.equal(url, rpcUrl);
    const body = JSON.parse(String(init?.body));
    const reply = (request: { id: number; method: string; params?: any[] }) => {
      let result: unknown = "0x0";
      if (request.method === "eth_chainId") result = "0x1";
      else if (request.method === "eth_getBalance") result = "0xde0b6b3a7640000";
      else if (request.method === "eth_getCode") result = "0x";
      else if (request.method === "eth_call") {
        const call = request.params![0];
        if (call.data.startsWith("0x12345678")) {
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
  try {
    await withFakeTor(async (url) => {
      assert.ok(bootstraps > 0, "Tor must be ready before any offchain lookup");
      torUrls.push(url);
      assert.equal(url, "https://read-rpc.invalid/gateway/0x0102");
      return gatewayResponse();
    }, async () => {
      await withTor(true, { rpcUrl }, async () => {
        assert.equal(await resolveAddressOrName("alice.eth", rpcUrl), recipient);
      });
      assert.deepEqual(torUrls, ["https://read-rpc.invalid/gateway/0x0102"]);
      assert.ok(directUrls.every((url) => url === rpcUrl));
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
        await run();
        assert.ok(torUrls.length > before, "recipient name must use the active Tor session");
        assert.equal(process.exitCode, 1, "failed offchain resolution must stop preparation");
        process.exitCode = originalExit;
      }
      assert.ok(directUrls.every((url) => url === rpcUrl), "offchain failures must not fall back to clearnet");
      const before = torUrls.length;
      await runUnshield({ ...opts, withoutTor: true });
      assert.equal(torUrls.length, before, "explicit --without-tor must be respected");
      assert.ok(directUrls.some((url) => url.includes("/gateway/")));
    }, async () => { bootstraps++; });
  } finally {
    globalThis.fetch = originalFetch;
    process.exitCode = originalExit;
    if (originalWithoutTor === undefined) delete process.env.KOHAKU_WITHOUT_TOR;
    else process.env.KOHAKU_WITHOUT_TOR = originalWithoutTor;
    rmSync(dataDir, { recursive: true, force: true });
  }
});
