import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { availableParallelism, cpus, freemem, loadavg, platform, release, totalmem } from "node:os";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";

const require = createRequire(import.meta.url);
const sdkDir = dirname(require.resolve("@kohaku-eth/tornado-cash/package.json"));
const backendUrl = pathToFileURL(join(sdkDir, "dist/merkle-tree.node.js"));
const mimcUrl = import.meta.resolve("@kohaku-eth/mimc-tree");
const version = (url) => JSON.parse(readFileSync(url, "utf8")).version;
const readOptional = (path) => { try { return readFileSync(path, "utf8").trim(); } catch { return undefined; } };

function runtimeInfo() {
  const cpu = cpus();
  const group = readOptional("/proc/self/cgroup")?.split("\n").find((line) => line.startsWith("0::"))?.slice(3);
  const cgroupDir = group && !group.split("/").includes("..") ? join("/sys/fs/cgroup", group) : "/sys/fs/cgroup";
  const memAvailable = readOptional("/proc/meminfo")?.match(/^MemAvailable:\s+(\d+) kB/m)?.[1];
  return {
    node: process.version, v8: process.versions.v8, platform: platform(), arch: process.arch, kernel: release(),
    cpu: cpu[0]?.model, logicalCpus: cpu.length, availableParallelism: availableParallelism(),
    load: loadavg(), totalMemoryGiB: totalmem() / 2 ** 30, freeMemoryGiB: freemem() / 2 ** 30,
    ...(memAvailable ? { availableMemoryGiB: Number(memAvailable) / 2 ** 20 } : {}),
    ...(platform() === "linux" ? {
      cgroupCpuMax: readOptional(join(cgroupDir, "cpu.max")),
      cgroupMemoryMax: readOptional(join(cgroupDir, "memory.max")),
      cpuPressure: readOptional("/proc/pressure/cpu"), memoryPressure: readOptional("/proc/pressure/memory"),
    } : {}),
    jitDisabled: /--jitless\b/.test([...process.execArgv, process.env.NODE_OPTIONS ?? ""].join(" ")),
    optimizationDisabled: /--no-opt\b/.test([...process.execArgv, process.env.NODE_OPTIONS ?? ""].join(" ")),
    tornadoSdk: version(join(sdkDir, "package.json")),
    mimcTree: version(new URL("../package.json", mimcUrl)),
  };
}

async function benchmark(leavesCount) {
  const importStart = performance.now();
  // Use the installed SDK's actual Node backend, also used by its state worker.
  const { buildTree } = await import(backendUrl.href);
  const { createMimcMerkleTree, generateMimcMerkleProof } = await import(mimcUrl);
  const importMs = performance.now() - importStart;
  const leaves = Array.from({ length: leavesCount }, (_, index) => BigInt(index + 1));
  const timed = async (fn) => {
    const start = performance.now();
    const value = await fn();
    return { value, ms: performance.now() - start };
  };
  const cold = await timed(() => buildTree(leaves));
  const warm = await timed(() => buildTree(leaves));
  const single = await timed(() => createMimcMerkleTree(leaves));
  const proof = await timed(() => generateMimcMerkleProof(warm.value, leaves[0]));
  if (cold.value.root !== warm.value.root || warm.value.root !== single.value.root ||
      BigInt(warm.value.root) !== proof.value.root) throw new Error("Merkle implementations produced different roots.");
  return { leaves: leavesCount, importMs, sdkParallelColdMs: cold.ms, sdkParallelWarmMs: warm.ms,
    singleThreadMs: single.ms, proofFromExistingTreeMs: proof.ms, rootsMatch: true };
}

async function runBounded(leaves, timeoutMs) {
  const worker = new Worker(new URL(import.meta.url), { workerData: { leaves } });
  let timer;
  try {
    return await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Benchmark exceeded ${timeoutMs}ms for ${leaves} leaves.`)), timeoutMs);
      worker.once("message", (result) => result.error ? reject(new Error(result.error)) : resolve(result));
      worker.once("error", reject);
      worker.once("exit", (code) => reject(new Error(`Benchmark worker exited before returning a result (${code}).`)));
    });
  } finally { clearTimeout(timer); await worker.terminate(); }
}

if (!isMainThread) {
  try { parentPort.postMessage(await benchmark(workerData.leaves)); }
  catch (error) { parentPort.postMessage({ error: error instanceof Error ? error.message : String(error) }); }
} else {
  const { values } = parseArgs({ options: { leaves: { type: "string" }, "timeout-ms": { type: "string", default: "60000" }, help: { type: "boolean" } } });
  if (values.help) {
    console.log("Usage: node scripts/diagnose-tornado-performance.mjs [--leaves 8192] [--timeout-ms 60000]\nUses synthetic leaves only; no wallet, RPC, or network access. Defaults to 1024 and 8192 leaves.");
  } else {
    const sizes = values.leaves === undefined ? [1024, 8192] : [Number(values.leaves)];
    const timeoutMs = Number(values["timeout-ms"]);
    if (sizes.some((n) => !Number.isSafeInteger(n) || n < 1 || n > 131072) ||
        !Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300000) {
      throw new Error("Use 1–131072 leaves and a timeout of 1000–300000ms.");
    }
    console.log(JSON.stringify({ runtime: runtimeInfo() }));
    for (const leaves of sizes) {
      console.log(JSON.stringify({ startingLeaves: leaves }));
      try { console.log(JSON.stringify(await runBounded(leaves, timeoutMs))); }
      catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; break; }
    }
  }
}
