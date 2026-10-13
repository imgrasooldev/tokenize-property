import { join } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // The same "@/..." imports as the app (tsconfig paths), for tests of server actions.
  resolve: { alias: { "@": join(import.meta.dirname, "src") } },
  test: {
    include: ["test/**/*.test.ts"],
    // Integration tests write to the test database (never the demo one) and the local chain, through
    // their own signing service (4901) and KYC service (4911) for the test database (test/stack.ts).
    env: { WEB_DB_NAME: "property_token_test", SIGNER_URL: "http://127.0.0.1:4901", KYC_URL: "http://127.0.0.1:4911" },
    fileParallelism: false,
    testTimeout: 180_000,
    hookTimeout: 400_000,
  },
});
