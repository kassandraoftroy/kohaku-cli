/** Check every published R2 object before activating or releasing a v2 manifest. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { parseSyncCacheV2Manifest, syncCacheV2BaseUrl } from "../src/utils/sync-cache-v2.js";

async function main(): Promise<void> {
  const [outputArg] = process.argv.slice(2);
  if (!outputArg) throw new Error("Usage: npx tsx scripts/check-sync-cache-v2-remote.ts <output-dir>");
  const raw = readFileSync(join(resolve(outputArg), "manifest.json"));
  const manifest = parseSyncCacheV2Manifest(raw.toString("utf8"));
  const base = syncCacheV2BaseUrl();
  const remoteManifest = await fetch(`${base}/manifest.json`);
  if (!remoteManifest.ok) throw new Error(`Remote manifest: HTTP ${remoteManifest.status}`);
  const remoteHash = createHash("sha256").update(Buffer.from(await remoteManifest.arrayBuffer())).digest("hex");
  const localHash = createHash("sha256").update(raw).digest("hex");
  if (remoteHash !== localHash) throw new Error(`Remote manifest differs from local release: ${remoteHash} != ${localHash}`);

  let next = 0;
  let present = 0;
  const missing: string[] = [];
  const worker = async () => {
    while (next < manifest.files.length) {
      const file = manifest.files[next++]!;
      const url = `${base}/${file.path}`;
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 120_000);
        try {
          const response = await fetch(url, { signal: controller.signal });
          if (!response.ok) {
            missing.push(`${response.status} ${file.path}`);
            continue;
          }
          const bytes = Buffer.from(await response.arrayBuffer());
          const digest = createHash("sha256").update(bytes).digest("hex");
          if (bytes.length !== file.bytes || digest !== file.sha256) {
            missing.push(`CORRUPT ${file.path} (${bytes.length} bytes, SHA-256 ${digest})`);
            continue;
          }
          present++;
        } finally {
          clearTimeout(timer);
        }
      } catch (error) {
        missing.push(`ERROR ${file.path}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  };
  await Promise.all(Array.from({ length: 12 }, () => worker()));
  console.log(`Release ${manifest.release}: ${present}/${manifest.files.length} objects present at ${base}`);
  for (const path of missing) console.log(path);
  if (missing.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
