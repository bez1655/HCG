import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/e2e/**/*.test.ts"],
    environment: "node",
    // One server process is shared across the suite, so files must not run
    // in parallel against the same port and data directory.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 40_000,
  },
});
