#!/usr/bin/env node
/**
 * Kohaku CLI entrypoint.
 *
 * Registers a resolve hook so Node can load @kohaku-eth packages that ship
 * extensionless / directory ESM imports (valid under tsx, not under plain Node).
 * Always invoke this file (npm bin / symlink), not dist/index.js directly.
 */
import { registerHooks } from "node:module";

// Built CLI runs as production unless the user overrides NODE_ENV.
if (process.env.NODE_ENV === undefined) {
  process.env.NODE_ENV = "production";
}

function hasResolvableExt(specifier) {
  return /\.(js|mjs|cjs|json|node|wasm)(\?|#|$)/.test(specifier);
}

/** Specifiers to try after the default resolver fails. */
function alternatives(specifier) {
  if (hasResolvableExt(specifier)) return [];

  // Directory self-imports used by some packages (e.g. stealth-address-sdk `from '.'`).
  if (specifier === "." || specifier === "./") {
    return ["./index.js"];
  }
  if (specifier === ".." || specifier === "../") {
    return ["../index.js"];
  }

  const alts = [];
  if (
    specifier.startsWith("./") ||
    specifier.startsWith("../") ||
    specifier.startsWith("/") ||
    specifier.startsWith("file:")
  ) {
    const trimmed = specifier.replace(/\/$/, "");
    // Prefer explicit file, then directory index (covers `./types` → `./types/index.js`).
    alts.push(`${trimmed}.js`);
    alts.push(`${trimmed}/index.js`);
  } else if (specifier.includes("/")) {
    // Bare package subpath without extension, e.g. maci-crypto/build/ts/hashing
    alts.push(`${specifier}.js`);
    alts.push(`${specifier}/index.js`);
  }
  return alts;
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (err) {
      const code = err?.code;
      if (
        code !== "ERR_MODULE_NOT_FOUND" &&
        code !== "ERR_UNSUPPORTED_DIR_IMPORT"
      ) {
        throw err;
      }
      for (const alt of alternatives(specifier)) {
        try {
          return nextResolve(alt, context);
        } catch {
          // try next candidate
        }
      }
      throw err;
    }
  },
});

await import("../dist/index.js");
