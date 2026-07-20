import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

export const TORNADO_PRE_VERIFICATION_GAS_LIMIT = 85_000n;

/** SDK default is 10k; TornadoFeeAdapter postOp needs more on Sepolia. */
export const TORNADO_PAYMASTER_POST_OP_GAS_LIMIT = 100_000n;

/** SDK default callGasLimit when tailCalls are set. */
export const TORNADO_BASE_CALL_GAS_LIMIT = 300_000n;

const TORNADO_EXECUTE_BATCH_OVERHEAD = 80_000n;
const TORNADO_EMPTY_CALL_GAS = 30_000n;
const TORNADO_NONEMPTY_CALL_FALLBACK_GAS = 350_000n;
const TORNADO_CALL_GAS_SAFETY_NUM = 15n;
const TORNADO_CALL_GAS_SAFETY_DEN = 10n; // 1.5×
const TORNADO_CALL_GAS_CAP = 5_000_000n;

/** Mirrors `@kohaku-eth/tornado-cash` `reasonableGasUnits` when tailCalls are set. */
export const TORNADO_PAYMASTER_GAS_UNITS = {
  preVerificationGas: TORNADO_PRE_VERIFICATION_GAS_LIMIT,
  verificationGasLimit: 50_000n,
  callGasLimit: TORNADO_BASE_CALL_GAS_LIMIT,
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

export type TornadoGasCall = {
  to: string;
  data: string;
  value?: bigint;
};

function calldataByteLength(data: string): number {
  if (!data || data === "0x") return 0;
  return Math.max(0, Math.floor((data.length - 2) / 2));
}

function heuristicCallGas(call: TornadoGasCall): bigint {
  const bytes = calldataByteLength(call.data);
  if (bytes === 0) return TORNADO_EMPTY_CALL_GAS;
  // Rough calldata floor + room for a Uniswap-style swap / router call.
  const calldataGas = BigInt(bytes) * 16n;
  const estimated = 150_000n + calldataGas;
  return estimated > TORNADO_NONEMPTY_CALL_FALLBACK_GAS
    ? estimated
    : TORNADO_NONEMPTY_CALL_FALLBACK_GAS;
}

/**
 * Heuristic UserOperation callGasLimit for Tornado execute/executeBatch.
 * Does not call eth_estimateGas — the account has no funds until the unshield
 * UserOp runs, so RPC estimation would fail with insufficient funds.
 */
export function estimateTornadoCallGasLimit(
  calls: readonly TornadoGasCall[]
): bigint {
  let callsGas = 0n;
  for (const call of calls) {
    callsGas += heuristicCallGas(call);
  }

  let callGasLimit =
    TORNADO_EXECUTE_BATCH_OVERHEAD +
    (callsGas * TORNADO_CALL_GAS_SAFETY_NUM) / TORNADO_CALL_GAS_SAFETY_DEN;

  if (callGasLimit < TORNADO_BASE_CALL_GAS_LIMIT) {
    callGasLimit = TORNADO_BASE_CALL_GAS_LIMIT;
  }
  if (callGasLimit > TORNADO_CALL_GAS_CAP) {
    callGasLimit = TORNADO_CALL_GAS_CAP;
  }

  return callGasLimit;
}

/** Same formula as tornado-cash `computeMinimumViableFee` (incl. 1.2× safety margin). */
export function estimateTornadoPaymasterFee(
  maxFeePerGas: bigint,
  opts?: {
    hasTailCalls?: boolean;
    isERC20?: boolean;
    callGasLimit?: bigint;
  }
): bigint {
  const hasTailCalls = opts?.hasTailCalls ?? true;
  const isERC20 = opts?.isERC20 ?? false;
  const callGasLimit = hasTailCalls
    ? (opts?.callGasLimit ?? TORNADO_PAYMASTER_GAS_UNITS.callGasLimit)
    : 0n;
  const units = {
    ...TORNADO_PAYMASTER_GAS_UNITS,
    callGasLimit,
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

let basePatched = false;

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

function patchWorkerBaseGasLimits(file: string): void {
  let source = readFileSync(file, "utf8");
  let changed = false;

  for (const { old, new: replacement, label } of WORKER_GAS_PATCHES) {
    if (source.includes(replacement)) continue;
    if (!source.includes(old)) {
      // console.warn(
      //   `[kohaku] Tornado ${label} patch skipped (constant missing in ${file})`
      // );
      continue;
    }
    source = source.replace(old, replacement);
    changed = true;
    // console.warn(`[kohaku] Patched Tornado ${label} in ${file}`);
  }

  if (changed) {
    writeFileSync(file, source);
  }
}

/**
 * Force the SDK worker's baseGasUnits.callGasLimit. Must run before the worker
 * is spawned (i.e. before createTCPlugin / first Tornado sync).
 */
function patchWorkerCallGasLimit(file: string, callGasLimit: bigint): void {
  let source = readFileSync(file, "utf8");
  const next = `callGasLimit: ${callGasLimit.toString()}n`;
  // Match the baseGasUnits field specifically (verificationGasLimit precedes it).
  const re =
    /(verificationGasLimit:\s*\d+n,\s*)callGasLimit:\s*\d+n/;
  if (!re.test(source)) {
    // console.warn(
    //   `[kohaku] Tornado callGasLimit patch skipped (pattern missing in ${file})`
    // );
    return;
  }
  const updated = source.replace(re, `$1${next}`);
  if (updated !== source) {
    writeFileSync(file, updated);
    // console.warn(
    //   `[kohaku] Patched Tornado callGasLimit to ${callGasLimit.toString()} in ${file}`
    // );
  }
}

/**
 * Bump `@kohaku-eth/tornado-cash` worker gas limits (idempotent for base
 * patches). When `callGasLimit` is provided it is always written; otherwise the
 * default is applied only on the first call so a prior override is preserved.
 * Node ignores `stateManagerWorkerUrl`, so we patch the bundled worker on disk.
 */
export function ensureTornadoPaymasterGasPatched(opts?: {
  callGasLimit?: bigint;
}): void {
  for (const file of tornadoWorkerFiles()) {
    if (!basePatched) {
      patchWorkerBaseGasLimits(file);
    }
    if (opts?.callGasLimit != null) {
      patchWorkerCallGasLimit(file, opts.callGasLimit);
    } else if (!basePatched) {
      patchWorkerCallGasLimit(file, TORNADO_BASE_CALL_GAS_LIMIT);
    }
  }

  basePatched = true;
}
