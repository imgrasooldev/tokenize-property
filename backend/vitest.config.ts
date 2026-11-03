import { defineConfig } from "vitest/config";

/**
 * Files that talk to the local Besu network or Anvil: one at a time, after the others (several at
 * once overload the RPC and share nonces).
 */
const CHAIN = [
  "packages/anchor/test/anchor-db.test.ts",
  "packages/anchor/test/anchorer.test.ts",
  "packages/anchor/test/anvil.test.ts",
  "packages/anchor/test/unit.test.ts",
  "packages/db/test/web-anchor.test.ts",
  "packages/indexer/test/indexer-db.test.ts",
  "packages/indexer/test/local-chain.test.ts",
  "packages/outbox/test/local-chain.test.ts",
  "packages/recon/test/local-chain.test.ts",
  "packages/recon/test/reconcile.test.ts",
  "packages/signer/test/e2e-chain.test.ts",
  "packages/signer/test/e2e-offboarding.test.ts",
  "packages/signer/test/service.test.ts",
  "packages/tax/test/rent-besu.test.ts",
];

export default defineConfig({
  test: {
    testTimeout: 30_000,
    // Each file copies the migrated template into its own database and drops it; on Windows the
    // drop's checkpoint fsyncs every new file, which can take tens of seconds on this laptop.
    hookTimeout: 60_000,
    // A pool keeps its connection after an expected SQL error (packages/db/test/keep-connections.ts).
    setupFiles: ["packages/db/test/keep-connections.ts"],
    // Every database file has a database of its own (packages/db/test/helpers.ts scratchDatabase):
    // four run at once, which overlaps their waits on the disk.
    maxWorkers: 4,
    projects: [
      { extends: true, test: { name: "db", include: ["packages/*/test/**/*.test.ts"], exclude: CHAIN, sequence: { groupOrder: 0 } } },
      { extends: true, test: { name: "chain", include: CHAIN, fileParallelism: false, sequence: { groupOrder: 1 } } },
    ],
  },
});
