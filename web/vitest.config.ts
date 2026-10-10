import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Integration tests write to the test database (never the demo one) and the local chain.
    env: { WEB_DB_NAME: "property_token_test" },
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
