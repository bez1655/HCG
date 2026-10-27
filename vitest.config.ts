import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Unit tests only. The end-to-end suite boots a real server, so it is
    // opt-in via `npm run test:e2e` to keep the default run fast.
    include: [
      "src/**/*.test.ts",
      "src/**/*.test.tsx",
      "bot/src/**/*.test.ts",
      "proxy-harvester/src/**/*.test.ts",
    ],
    environment: "node",
  },
});
