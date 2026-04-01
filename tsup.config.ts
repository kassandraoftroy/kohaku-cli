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
  ],
});
