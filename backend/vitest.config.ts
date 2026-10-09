import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts"],
    // Database tests share one test database; run files one at a time.
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
