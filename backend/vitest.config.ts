import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts"],
    // Database tests share one test database; run files one at a time.
    fileParallelism: false,
    testTimeout: 30_000,
    // Each file builds its own database (all migrations) and drops it; on Windows the drop's
    // checkpoint fsyncs every new file, which can take tens of seconds on this laptop.
    hookTimeout: 60_000,
  },
});
