import { http } from "viem";
import { createBundlerClient } from "viem/account-abstraction";
import type { SerializedUserOperation } from "./tornado-paymaster-broadcaster.js";

type Withdrawal = {
  mode: "paymaster";
  bundlerUrl: string;
  entryPointAddress: `0x${string}`;
  userOperation: SerializedUserOperation;
};
type GasField = "preVerificationGas" | "verificationGasLimit" | "callGasLimit" |
  "paymasterVerificationGasLimit" | "paymasterPostOpGasLimit";
type GasEstimate = Partial<Record<GasField, `0x${string}`>>;
type Estimate = (withdrawal: Withdrawal) => Promise<GasEstimate>;

async function estimate(withdrawal: Withdrawal): Promise<GasEstimate> {
  const client = createBundlerClient({
    transport: http(withdrawal.bundlerUrl, { timeout: 180_000, retryCount: 0 }),
  });
  return client.request({
    method: "eth_estimateUserOperationGas",
    params: [withdrawal.userOperation, withdrawal.entryPointAddress],
  });
}

/** Validate the final signed payload before confirmation. Never edit signed gas/proof data. */
export async function preflightTornadoUnshield(
  operation: unknown,
  estimateGas: Estimate = estimate
): Promise<void> {
  const withdrawals = (operation as { withdrawals?: Withdrawal[] } | null)?.withdrawals;
  if (!withdrawals?.length) throw new Error("Tornado unshield is missing its prepared paymaster withdrawals.");
  for (const withdrawal of withdrawals) {
    if (withdrawal.mode !== "paymaster" || !withdrawal.userOperation) {
      throw new Error("Tornado unshield is missing a signed paymaster operation.");
    }
    let required: GasEstimate;
    try {
      required = await estimateGas(withdrawal);
    } catch (error) {
      const details = error instanceof Error && "details" in error && typeof error.details === "string"
        ? error.details : error instanceof Error ? error.message.split("\n")[0] : String(error);
      throw new Error(
        `Tornado unshield gas preflight failed before broadcast: ${details}. ` +
        "No operation was submitted. The SDK may have fallen back to static gas limits. " +
        "Retry preparation when the bundler is available; a gas-budget rejection needs the fee, proof and signature rebuilt by the SDK. " +
        "Choosing fewer notes may help simulation failures, but cannot fix an insufficient gas budget by itself."
      );
    }
    if (required.preVerificationGas == null || BigInt(required.preVerificationGas) <= 0n) {
      throw new Error("Tornado bundler returned no usable preVerificationGas estimate. Unshield stopped before broadcast.");
    }
    for (const field of ["preVerificationGas", "verificationGasLimit", "callGasLimit", "paymasterVerificationGasLimit", "paymasterPostOpGasLimit"] as const) {
      // A direct single-note withdrawal has no execution phase; the SDK must keep this at zero.
      if (field === "callGasLimit" && withdrawal.userOperation.callData === "0x") continue;
      if (required[field] == null) continue;
      const needed = BigInt(required[field]!);
      const supplied = BigInt(withdrawal.userOperation[field] ?? "0x0");
      if (needed > supplied) {
        throw new Error(
          `Tornado unshield stopped before broadcast: signed ${field} is ${supplied}, but the bundler requires ${needed}. ` +
          "The SDK must rebuild this withdrawal with updated gas limits, paymaster fee, proof and signature. " +
          "Changing the amount alone does not resolve this gas-budget error. No operation was submitted."
        );
      }
    }
  }
}
