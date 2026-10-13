import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const alias = { "@": fileURLToPath(new URL("./src", import.meta.url)) };

export default defineConfig({
  resolve: { alias },
  test: {
    // Database tests build their own scratch databases (pt_scratch_admin_*), never property_token.
    fileParallelism: false,
    testTimeout: 60_000,
    // Creating and dropping a database waits for a checkpoint on Windows (MEMORY: slow test databases).
    hookTimeout: 180_000,
    projects: [
      { resolve: { alias }, test: { name: "unit", include: ["test/unit/**/*.test.ts"] } },
      {
        resolve: { alias },
        test: { name: "db", include: ["test/db/**/*.test.ts"], fileParallelism: false, testTimeout: 60_000, hookTimeout: 180_000 },
      },
      {
        // Needs a production build (npm run build) and PostgreSQL; starts `next start` itself.
        resolve: { alias },
        test: { name: "http", include: ["test/http/**/*.test.ts"], fileParallelism: false, testTimeout: 60_000, hookTimeout: 240_000 },
      },
    ],
  },
});
