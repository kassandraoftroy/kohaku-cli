import { readFileSync } from "node:fs";

/** Resolve an optional dependency using the lockfile's Node module layout. */
function resolveEntry(packages, parent, name) {
  let directory = parent;
  while (directory) {
    const candidate = packages[`${directory}/node_modules/${name}`];
    if (candidate) return candidate;
    const separator = directory.lastIndexOf("/node_modules/");
    directory = separator === -1 ? "" : directory.slice(0, separator);
  }
  return packages[`node_modules/${name}`];
}

const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));
const errors = [];
let checked = 0;
for (const [parent, entry] of Object.entries(lock.packages)) {
  for (const [name, version] of Object.entries(entry.optionalDependencies ?? {})) {
    // These are exact-version, platform-specific build helpers. Check every
    // platform, including packages that cannot be installed on this machine.
    if (!/^@(rollup\/rollup-|esbuild\/|napi-rs\/lzma-)/.test(name)) continue;
    checked++;
    const native = resolveEntry(lock.packages, parent, name);
    if (!native || native.version !== version || !native.integrity || !native.optional) {
      errors.push(`${parent}: ${name}@${version}`);
    }
  }
}
if (!checked || errors.length) {
  console.error("Platform binaries are missing or inconsistent in package-lock.json:");
  console.error(errors.join("\n") || "No native build helpers found.");
  console.error("Regenerate the affected dependency entries without node_modules; do not commit a lockfile containing only your local platform.");
  process.exitCode = 1;
} else {
  console.log(`Lockfile includes all ${checked} pinned native build helpers across platforms.`);
}
