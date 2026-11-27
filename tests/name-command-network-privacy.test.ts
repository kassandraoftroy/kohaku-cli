import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { Command } from "commander";
import { encodeAbiParameters, encodeErrorResult, offchainLookupAbiItem, type Hex } from "viem";
import { mainnet } from "viem/chains";
import { registerExportPrivateKeyCommand } from "../src/commands/exportPrivateKey.js";
import { withNameCommandContext } from "../src/lib/names/cli.js";
import { readNameOwnership } from "../src/lib/names/ops.js";
import { ENS_BASE_REGISTRAR, ENS_REGISTRY } from "../src/lib/names/constants.js";
import { writeSeedKeystore } from "../src/utils/mnemonic.js";
import { makePublicAccountsStorage } from "../src/utils/public-accounts.js";
import { makePublicClient } from "../src/utils/rpc.js";
import { writeWalletType } from "../src/utils/wallets-util.js";
import { withFakeTor } from "./helpers/fake-tor.js";

const mnemonic = "test test test test test test test test test test test junk";
const rpcUrl = "https://name-command-rpc.invalid/rpc";
const gateway = "https://name-command-rpc.invalid/gateway/{data}";
const resolver = mainnet.contracts.ensUniversalResolver.address;
const callbacks = { forward: "0x12345671", text: "0x12345672" } as const;

it("protects name-management RPC reads and standalone key-export resolution, allowing only explicit opt-outs", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "kohaku-name-command-privacy-"));
  const walletDir = join(dataDir, "test");
  writeSeedKeystore(mnemonic, "password", walletDir);
  writeWalletType("mainnet", walletDir);
  const accounts = makePublicAccountsStorage(walletDir, mnemonic, "password");
  accounts.addNextAccounts(1);
  const account = accounts.getAccount(0)!.address as Hex;
  const originalFetch = globalThis.fetch;
  const originalWithoutTor = process.env.KOHAKU_WITHOUT_TOR;
  const originalExit = process.exitCode;
  const originalLog = console.log;
  const originalError = console.error;
  delete process.env.KOHAKU_WITHOUT_TOR;
  let allowDirectNames = false;
  let failTorCalls = false;
  let bootstraps = 0;
  const directCalls: string[] = [];
  const torCalls: string[] = [];
  const printed: unknown[][] = [];
  console.log = (...args) => { printed.push(args); };
  console.error = () => {};

  function reply(request: { id: number; method: string; params?: any[] }, via: "tor" | "direct") {
    (via === "tor" ? torCalls : directCalls).push(request.method);
    let result: unknown = "0x1";
    if (request.method === "eth_call") {
      assert.ok(via === "tor" || allowDirectNames, "name contract calls must never reach clearnet");
      if (via === "tor" && failTorCalls) throw new Error("fixture private RPC unavailable");
      const call = request.params![0];
      if ([ENS_BASE_REGISTRAR, ENS_REGISTRY].some(address => address.toLowerCase() === call.to.toLowerCase())) {
        result = encodeAbiParameters([{ type: "address" }], [account]);
      } else {
        assert.equal(call.to.toLowerCase(), resolver.toLowerCase());
        const callback = (Object.keys(callbacks) as Array<keyof typeof callbacks>)
          .find(kind => call.data.startsWith(callbacks[kind]));
        if (callback) {
          result = encodeAbiParameters([{ type: "bytes" }, { type: "address" }], [
            callback === "text"
              ? encodeAbiParameters([{ type: "string" }], ["fixture text"])
              : encodeAbiParameters([{ type: "address" }], [account]),
            resolver,
          ]);
        } else {
          // text(bytes32,string) is present in the Universal Resolver calldata.
          const kind = call.data.includes("59d1d43c") ? "text" : "forward";
          return { jsonrpc: "2.0", id: request.id, error: { code: 3, message: "execution reverted",
            data: encodeErrorResult({ abi: [offchainLookupAbiItem], errorName: "OffchainLookup",
              args: [call.to, [gateway], kind === "text" ? "0x02" : "0x01", callbacks[kind], "0x"] }) } };
        }
      }
    } else {
      assert.ok(["eth_chainId", "eth_getBalance"].includes(request.method));
    }
    return { jsonrpc: "2.0", id: request.id, result };
  }

  async function respond(input: string, init: { body?: unknown } | undefined, via: "tor" | "direct") {
    if (input.includes("/gateway/")) {
      assert.ok(via === "tor" || allowDirectNames, "CCIP must not inherit the RPC-host exemption");
      (via === "tor" ? torCalls : directCalls).push("ccip");
      return Response.json({ data: "0x1234" });
    }
    assert.equal(input, rpcUrl);
    const body = JSON.parse(String(init?.body));
    return Response.json(Array.isArray(body) ? body.map(request => reply(request, via)) : reply(body, via));
  }
  globalThis.fetch = async (input, init) => respond(String(input), init, "direct");
  const opts = { wallet: "test", password: "password", dataDir, rpcUrl, nonInteractive: true };
  let completed = 0;
  const runNameChecks = (withoutTor = false) => withNameCommandContext({ ...opts, withoutTor }, async ({ client }) => {
    const ownership = await readNameOwnership(client, { protocol: "ens", label: "alice", name: "alice.eth" });
    assert.equal(ownership.owner.toLowerCase(), account.toLowerCase());
    assert.equal(await client.getEnsText({ name: "alice.eth", key: "url" }), "fixture text");
    completed++;
  });
  try {
    await withFakeTor(async (url, init) => respond(url, init, "tor"), async () => {
      await runNameChecks();
      assert.equal(completed, 1);
      assert.ok(torCalls.includes("eth_call"));
      assert.ok(torCalls.includes("ccip"));
      assert.ok(!directCalls.includes("eth_call") && !directCalls.includes("ccip"));
      assert.equal(bootstraps, 1);

      // Ordinary balance reads retain the public RPC route.
      const ordinary = await makePublicClient(rpcUrl);
      assert.equal(await ordinary.getBalance({ address: account }), 1n);
      assert.ok(directCalls.includes("eth_getBalance"));

      // This command has no outer name-command scope; resolution must start Tor.
      const beforeExport = bootstraps;
      const command = new Command();
      registerExportPrivateKeyCommand(command);
      await command.parseAsync(["export-private-key", "--wallet", "test", "--password", "password",
        "--dataDir", dataDir, "--rpc-url", rpcUrl, "--non-interactive", "--address", "alice.eth"], { from: "user" });
      assert.equal(process.exitCode, originalExit);
      assert.equal(bootstraps, beforeExport + 1, "standalone resolution keeps RPC and callback in one Tor session");
      assert.ok(printed.length > 0, "key export completed for the fixture account");
      assert.ok(!directCalls.includes("eth_call") && !directCalls.includes("ccip"));

      const beforeOptOut = bootstraps;
      allowDirectNames = true;
      await runNameChecks(true);
      assert.equal(completed, 2);
      assert.equal(bootstraps, beforeOptOut);
      assert.ok(directCalls.includes("eth_call") && directCalls.includes("ccip"));
      process.env.KOHAKU_WITHOUT_TOR = "1";
      await runNameChecks();
      assert.equal(completed, 3);
      assert.equal(bootstraps, beforeOptOut);
      delete process.env.KOHAKU_WITHOUT_TOR;
      allowDirectNames = false;

      const directBeforeFailure = directCalls.filter(method => method === "eth_call" || method === "ccip").length;
      failTorCalls = true;
      await runNameChecks();
      assert.equal(process.exitCode, 1);
      assert.equal(completed, 3, "a failed private lookup must stop the command");
      assert.equal(directCalls.filter(method => method === "eth_call" || method === "ccip").length, directBeforeFailure);
    }, async () => { bootstraps++; });
  } finally {
    console.log = originalLog;
    console.error = originalError;
    globalThis.fetch = originalFetch;
    process.exitCode = originalExit;
    if (originalWithoutTor === undefined) delete process.env.KOHAKU_WITHOUT_TOR;
    else process.env.KOHAKU_WITHOUT_TOR = originalWithoutTor;
    rmSync(dataDir, { recursive: true, force: true });
  }
});
