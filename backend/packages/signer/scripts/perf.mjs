// Speed budgets with their full limits, for a quiet machine (task T-001): the unit suite only gates
// medians or generous bounds because tail latency and elapsed time follow machine load.
//   npm run perf          every budget (signer p50 < 25 / p99 < 50 ms, indexer reads p95 < 100 ms,
//                         follow < 1 s, outbox NOTIFY < 1.5 s)
//   npm run perf:signer   only the signer
import { spawnSync } from "node:child_process";
import process from "node:process";

const only = process.argv[2];
const files =
  only === "signer"
    ? ["packages/signer/test/service.test.ts", "-t", "speed"]
    : [
        "packages/signer/test/service.test.ts",
        "packages/indexer/test/local-chain.test.ts",
        "packages/indexer/test/indexer-db.test.ts",
        "packages/outbox/test/worker.test.ts",
      ];
const r = spawnSync("npx", ["vitest", "run", ...files], {
  stdio: "inherit",
  shell: process.platform === "win32",
  env: { ...process.env, PT_PERF_GATES: "1" },
});
process.exit(r.status ?? 1);
