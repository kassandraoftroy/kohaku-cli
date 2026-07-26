import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  platform: "node",
  target: "es2022",
  clean: true,
  sourcemap: true,
  banner: {
    js: "#!/usr/bin/env node",
  },
  outDir: "dist",
  external: [
    "@kohaku-eth/railgun",
    "@kohaku-eth/plugins",
    "@kohaku-eth/provider",
    "@kohaku-eth/provider/ethers",
    // Keep tor-js out of the bundle so wasm-file can resolve tor_js_bg.wasm
    // next to the package on disk.
    "tor-js",
    /^tor-js\//,
  ],
});
