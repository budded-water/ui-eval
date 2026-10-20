import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/capture-playwright/**/*.capture.ts"],
    // Each file owns real Chromium processes. Keep host contention out of the
    // lifecycle deadline checks; concurrency regressions are tested explicitly.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
