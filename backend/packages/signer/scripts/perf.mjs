// Signer latency benchmark with the full budget (p50 < 25 ms, p99 < 50 ms). Run it on a quiet
// machine; the unit suite only gates the median because tail latency follows machine load (T-001).
//   npm run perf:signer
import { spawnSync } from "node:child_process";
import process from "node:process";

const r = spawnSync("npx", ["vitest", "run", "packages/signer/test/service.test.ts", "-t", "speed"], {
  stdio: "inherit",
  shell: process.platform === "win32",
  env: { ...process.env, PT_PERF_GATES: "1" },
});
process.exit(r.status ?? 1);
