import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../../db/src/migrate.ts";
import { scratchDatabase } from "../../db/test/helpers.ts";
import { deploymentFromBroadcast, Indexer, LOCAL_BROADCAST, rpcSource, verify } from "../../indexer/src/index.ts";
import { viemChainState } from "../src/chain.ts";
import { reconcile } from "../src/run.ts";

/**
 * Integration on the real local Besu network, READ-ONLY (nothing is sent): index the deployment into
 * a scratch database, then run a full reconciliation against the contracts at the pinned block,
 * including the indexer's verify. The scratch database has no ledger, so every on-chain mint must be
 * reported as an orphan (exactly once) and every finalized or paid distribution as unbooked, while
 * supply, holdings and integrity agree. Skipped when no network or deployment is available (CI).
 */
const RPC = process.env.CHAIN_RPC_URL ?? "http://127.0.0.1:8545";
const deployment = deploymentFromBroadcast(process.env.INDEXER_DEPLOYMENT_FILE ?? LOCAL_BROADCAST);
const source = rpcSource(RPC, { timeoutMs: 5_000 });

async function up(): Promise<boolean> {
  try {
    return deployment !== null && (await source.chainId()) === 586_586;
  } catch {
    return false;
  }
}
const live = await up();

describe.skipIf(!live)("reconciliation on the local chain", () => {
  let pool: pg.Pool;
  let drop: () => Promise<void>;

  beforeAll(async () => {
    const s = await scratchDatabase();
    drop = s.drop;
    await migrate(s.client, fileURLToPath(new URL("../../db/migrations", import.meta.url)));
    pool = new pg.Pool({ ...s.settings, max: 8 });
  });

  afterAll(async () => {
    await pool.end();
    await drop();
  });

  it("agrees with the contracts at the pinned block and reports every unbooked mint exactly once", async () => {
    if (!deployment) throw new Error("no deployment");
    const ix = new Indexer(pool, source, deployment);
    await ix.register();
    await ix.catchUp();

    const report = await reconcile(pool, {
      deployment,
      chain: viemChainState(source.client),
      actor: "local-chain-test",
      verifyIndexer: async () => {
        const v = await verify(pool, source, deployment, { state: source.client });
        return { pinnedBlock: v.pinnedBlock, problems: v.problems };
      },
    });
    const { rows } = await pool.query<{ ref_id: string }>("SELECT ref_id FROM chain.issuances WHERE deployment = $1 AND kind = 'mint'", [deployment.id]);
    const orphans = report.findings.filter((f) => f.check === "issuance.orphan_mint").map((f) => f.subject);
    expect(orphans.sort()).toEqual(rows.map((r) => `refId ${r.ref_id}`).sort());
    const blocking = new Set(report.findings.filter((f) => f.severity === "blocking").map((f) => f.check));
    for (const c of blocking) expect(["issuance.orphan_mint", "rent.missing_ledger", "rent.payout_missing"]).toContain(c);
    expect(report.findings.filter((f) => /^(supply|holdings|integrity)\./.test(f.check) && f.check !== "integrity.indexer_lag")).toEqual([]);
    expect(report.status).toBe(blocking.size > 0 ? "failed" : "passed");

    process.stdout.write(`\n[recon speed] local chain: run ${String(report.ms)} ms, pinned block ${String(report.pinnedBlock)}, ` +
      `${JSON.stringify(report.summary.timings)}, ${JSON.stringify(report.summary.counts)}\n`);
  }, 300_000);
});
