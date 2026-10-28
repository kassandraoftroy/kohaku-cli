import type { PaymasterGasEstimation } from "@kohaku-eth/tornado-cash";

type PreparedWithdrawal = {
  fee?: bigint | string;
  proof?: { args?: readonly unknown[] };
  userOperation?: { sender?: `0x${string}` };
};

/** Read the fee bound into every sponsoring proof, never a new gas/TWAP estimate. */
export function tornadoPreparedFee(operation: unknown): bigint {
  const withdrawals = (operation as { withdrawals?: PreparedWithdrawal[] } | null)?.withdrawals;
  if (!withdrawals?.length) throw new Error("Tornado unshield is missing its prepared withdrawals.");
  return withdrawals.reduce((sum, withdrawal) => {
    const proofFee = withdrawal.proof?.args?.[4];
    if (typeof proofFee !== "bigint" && typeof proofFee !== "string") {
      throw new Error("Tornado prepared withdrawal is missing its proof-bound fee.");
    }
    const fee = BigInt(proofFee);
    if (fee < 0n || (withdrawal.fee != null && BigInt(withdrawal.fee) !== fee)) {
      throw new Error("Tornado prepared withdrawal fee does not match its proof.");
    }
    return sum + fee;
  }, 0n);
}

export function tornadoPreparedSender(operation: unknown): `0x${string}` | undefined {
  return (operation as { withdrawals?: PreparedWithdrawal[] } | null)?.withdrawals?.[0]?.userOperation?.sender;
}

/** Human-readable status; do not echo raw bundler errors or signed payloads. */
export function tornadoEstimationWarning(estimates: readonly PaymasterGasEstimation[]): string | undefined {
  if (!estimates.some((estimate) => estimate.status === "fallback")) return undefined;
  return "Gas estimation was unavailable. This withdrawal uses the SDK's conservative fallback budget and may cost more or be rejected by the bundler. Execution can still fail and leave funds on the EIP-7702 sender.";
}
