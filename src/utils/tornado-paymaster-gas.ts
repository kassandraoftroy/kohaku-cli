import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

export const TORNADO_PRE_VERIFICATION_GAS_LIMIT = 85_000n;

/** SDK default is 10k; TornadoFeeAdapter postOp needs more on Sepolia. */
export const TORNADO_PAYMASTER_POST_OP_GAS_LIMIT = 100_000n;

/** Mirrors `@kohaku-eth/tornado-cash` `reasonableGasUnits` when tailCalls are set. */
export const TORNADO_PAYMASTER_GAS_UNITS = {
  preVerificationGas: TORNADO_PRE_VERIFICATION_GAS_LIMIT,
  verificationGasLimit: 50_000n,
  callGasLimit: 300_000n,
  paymasterVerificationGasLimit: 350_000n,
  paymasterPostOpGasLimit: TORNADO_PAYMASTER_POST_OP_GAS_LIMIT,
} as const;

const ERC20_TRANSFER_GAS = 100_000n;

const WORKER_GAS_PATCHES: Array<{ old: string; new: string; label: string }> = [
  {
    old: "preVerificationGas: 80000n",
    new: "preVerificationGas: 85000n",
    label: "preVerificationGas",
  },
  {
    old: "paymasterPostOpGasLimit: 10000n",
    new: "paymasterPostOpGasLimit: 100000n",
    label: "paymasterPostOpGasLimit",
  },
];

/** Same formula as tornado-cash `computeMinimumViableFee` (incl. 1.2× safety margin). */
export function estimateTornadoPaymasterFee(
  maxFeePerGas: bigint,
  opts?: { hasTailCalls?: boolean; isERC20?: boolean }
): bigint {
  const hasTailCalls = opts?.hasTailCalls ?? true;
  const isERC20 = opts?.isERC20 ?? false;
  const units = {
    ...TORNADO_PAYMASTER_GAS_UNITS,
    callGasLimit: hasTailCalls ? TORNADO_PAYMASTER_GAS_UNITS.callGasLimit : 0n,
    paymasterVerificationGasLimit: isERC20
      ? TORNADO_PAYMASTER_GAS_UNITS.paymasterVerificationGasLimit +
        ERC20_TRANSFER_GAS
      : TORNADO_PAYMASTER_GAS_UNITS.paymasterVerificationGasLimit,
  };
  const requiredGas =
    units.verificationGasLimit +
    units.callGasLimit +
    units.paymasterVerificationGasLimit +
    units.preVerificationGas +
    units.paymasterPostOpGasLimit;
  return (requiredGas * maxFeePerGas * 12n) / 10n;
}

import { fetchPimlicoMaxFeePerGas } from "./pimlico-gas.js";

export async function fetchTornadoMaxFeePerGas(
  bundlerUrl: string
): Promise<bigint> {
  return fetchPimlicoMaxFeePerGas(bundlerUrl);
}

export async function resolveTornadoPrepareMaxFeePerGas(
  chainId: bigint
): Promise<bigint> {
  const { railgunPimlicoBundlerUrl } = await import("./rpc.js");
  return fetchPimlicoMaxFeePerGas(railgunPimlicoBundlerUrl(chainId));
}

let patched = false;

function tornadoWorkerFiles(): string[] {
  const require = createRequire(import.meta.url);
  const pkgRoot = dirname(
    require.resolve("@kohaku-eth/tornado-cash/package.json")
  );
  return [
    join(pkgRoot, "dist/state-manager.worker.node.js"),
    join(pkgRoot, "dist/state-manager.worker.js"),
  ];
}

function patchWorkerGasLimits(file: string): void {
  let source = readFileSync(file, "utf8");
  let changed = false;

  for (const { old, new: replacement, label } of WORKER_GAS_PATCHES) {
    if (source.includes(replacement)) continue;
    if (!source.includes(old)) {
      console.warn(
        `[kohaku] Tornado ${label} patch skipped (constant missing in ${file})`
      );
      continue;
    }
    source = source.replace(old, replacement);
    changed = true;
    console.warn(`[kohaku] Patched Tornado ${label} in ${file}`);
  }

  if (changed) {
    writeFileSync(file, source);
  }
}

/**
 * Bump `@kohaku-eth/tornado-cash` worker gas limits (idempotent).
 * Node ignores `stateManagerWorkerUrl`, so we patch the bundled worker on disk.
 */
export function ensureTornadoPaymasterGasPatched(): void {
  if (patched) return;

  for (const file of tornadoWorkerFiles()) {
    patchWorkerGasLimits(file);
  }

  patched = true;
}
