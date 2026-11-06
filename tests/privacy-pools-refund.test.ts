import assert from "node:assert/strict";
import { test } from "node:test";
import { PPv1ExactOutputError } from "@kohaku-eth/privacy-pools";
import { preparePrivacyPoolsUnshield } from "../src/lib/privacy-pools-unshield.js";
import type { ResolvedTokenMeta } from "../src/utils/tokens-util.js";

const recipient = "0x2222222222222222222222222222222222222222";
const ETH = { isEth: true, tokenAddress: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
  symbol: "ETH", decimals: 18 } as ResolvedTokenMeta;
const balance = 10n ** 18n;
type Options = { refundRecipient?: string; exact?: object; delegation?: object };
function plugin(prepare: (asset: { amount: bigint }, to: string, options: Options) => Promise<unknown>) {
  return { notes: async () => [{ balance, approved: true, assetAddress: BigInt(ETH.tokenAddress) }],
    prepareUnshield: prepare } as never;
}

test("Privacy Pools custom --to receives gas refunds for max, exact and fallback withdrawals", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    assert.equal(request.method, "pimlico_getUserOperationGasPrice");
    return Response.json({ result: { standard: { maxFeePerGas: "0x2", maxPriorityFeePerGas: "0x1" } } });
  };
  try {
    for (const mode of ["max", "exact", "fallback"] as const) {
      let calls = 0;
      await preparePrivacyPoolsUnshield({
        plugin: plugin(async (_asset, to, options) => {
          calls++;
          assert.equal(to, recipient);
          assert.equal(options.refundRecipient, recipient);
          assert.equal(options.delegation, undefined);
          if (mode === "fallback" && calls === 1) {
            assert.deepEqual(options.exact, {});
            throw new PPv1ExactOutputError(100n, 99n);
          }
          assert.deepEqual(options.exact, mode === "exact" ? {} : undefined);
          return { withdrawal: { fee: 1n } };
        }),
        chainId: 1n, rpcUrl: "https://rpc.invalid", tokenMeta: ETH,
        amountWei: balance / 10n, amountMax: mode === "max", recipient, tailCalls: [],
      });
      assert.equal(calls, mode === "fallback" ? 2 : 1);
    }
  } finally { globalThis.fetch = originalFetch; }
});

test("Privacy Pools keeps the refund recipient through execution-path fee repricing", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({
    result: { standard: { maxFeePerGas: "0x2", maxPriorityFeePerGas: "0x1" } },
  });
  let calls = 0;
  try {
    await preparePrivacyPoolsUnshield({
      plugin: plugin(async (asset, to, options) => {
        calls++;
        assert.equal(to, recipient);
        assert.equal(options.refundRecipient, recipient);
        assert.deepEqual(options.delegation, { mode: "deterministic", path: "m/44'/60'/0'/0/1" });
        // Force a second preparation with a larger proof-bound fee.
        return { withdrawal: { fee: calls === 1 ? asset.amount - balance / 10n + 1n : 1n } };
      }),
      chainId: 1n, rpcUrl: "https://rpc.invalid", tokenMeta: ETH,
      amountWei: balance / 10n, recipient,
      recipientDerivationPath: "m/44'/60'/0'/0/1",
      tailCalls: [{ to: recipient, value: 0n, data: "0x" }],
    });
    assert.equal(calls, 2);
  } finally { globalThis.fetch = originalFetch; }
});
