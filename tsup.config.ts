import { defineConfig } from "tsup"

export default defineConfig([
  {
    entry: { index: "src/index.ts" },
    format: ["esm"],
    platform: "node",
    target: "node20",
    dts: true,
    sourcemap: true,
    splitting: false,
    clean: true,
  },
  {
    entry: { cli: "src/cli/entry.ts" },
    format: ["esm"],
    platform: "node",
    target: "node20",
    dts: false,
    sourcemap: true,
    splitting: false,
    clean: false,
    banner: { js: "#!/usr/bin/env node" },
  },
])
