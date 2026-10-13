import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deploymentFromBroadcast, LOCAL_BROADCAST } from "../src/deployment.ts";
import { Indexer } from "../src/indexer.ts";
import { distributionsOf, holders, portfolio, transfersOf } from "../src/queries.ts";
import { rpcSource } from "../src/source.ts";
import { verify } from "../src/verify.ts";
import { migratedDatabase } from "./helpers.ts";

/**
 * End to end on the real local Besu network, READ-ONLY (nothing is sent to the chain): index the
 * whole deployment into a scratch database, verify it against a rebuild and against balanceOf and
 * the other view functions at the pinned block, and measure catch-up and read speed. Skipped when
 * the network or a deployment is not available (as in CI).
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

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? NaN;
}

async function latency(n: number, fn: () => Promise<unknown>): Promise<{ p50: number; p95: number; p99: number }> {
  await fn(); // warm up the plan cache
  const times: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = performance.now();
    await fn();
    times.push(performance.now() - t);
  }
  times.sort((a, b) => a - b);
  return { p50: percentile(times, 50), p95: percentile(times, 95), p99: percentile(times, 99) };
}

describe.skipIf(!live)("indexer on the local chain", () => {
  let pool: pg.Pool;
  let drop: () => Promise<void>;
  const d = deployment;

  beforeAll(async () => {
    let settings: pg.ClientConfig;
    ({ settings, drop } = await migratedDatabase());
    pool = new pg.Pool({ ...settings, max: 8 });
  });

  afterAll(async () => {
    await pool.end();
    await drop();
  });

  it("catches up from the deployment block, matches a rebuild and the contracts' own state, and reads fast", async () => {
    if (!d) throw new Error("no deployment");
    const ix = new Indexer(pool, source, d);
    await ix.register();
    const t0 = performance.now();
    const caught = await ix.catchUp();
    const catchUpMs = performance.now() - t0;
    expect(caught.blocks).toBeGreaterThan(0n);
    expect(caught.events).toBeGreaterThan(0);

    const report = await verify(pool, source, d, { state: source.client });
    expect(report.problems).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.holders).toBeGreaterThan(0);
    expect(report.stateReads).toBeGreaterThan(report.holders);

    const top = await holders(pool, d.contracts.token, 10);
    const someone = top[0]?.holder ?? d.contracts.token;
    const reads = {
      holders: await latency(200, () => holders(pool, d.contracts.token, 50)),
      portfolio: await latency(200, () => portfolio(pool, someone)),
      transfers: await latency(200, () => transfersOf(pool, someone, 50)),
      distributions: await latency(200, () => distributionsOf(pool, d.contracts.token)),
    };
    // ADR 0001 target p95 < 100 ms, enforced with PT_PERF_GATES=1 on a quiet machine; the unit run
    // gates the median only, because the tail follows machine load (T-001).
    const fullBudget = process.env.PT_PERF_GATES === "1";
    for (const r of Object.values(reads)) expect(fullBudget ? r.p95 : r.p50).toBeLessThan(100);

    const fmt = (r: { p50: number; p95: number; p99: number }): string => `${r.p50.toFixed(2)}/${r.p95.toFixed(2)}/${r.p99.toFixed(2)} ms`;
    process.stdout.write(
      `\n[indexer speed] catch-up ${caught.blocks.toString()} blocks, ${String(caught.events)} events, ${String(caught.batches)} batches in ${(catchUpMs / 1000).toFixed(2)} s ` +
      `= ${Math.round(Number(caught.blocks) / (catchUpMs / 1000)).toString()} blocks/s; verify ${String(report.ms)} ms (${String(report.stateReads)} contract reads)\n` +
      `[indexer speed] reads p50/p95/p99: holders ${fmt(reads.holders)}, portfolio ${fmt(reads.portfolio)}, transfers ${fmt(reads.transfers)}, distributions ${fmt(reads.distributions)}\n`,
    );

    // Running again changes nothing (idempotent), and the follow mode keeps up with new blocks.
    const before = (await ix.cursor()).events;
    await ix.catchUp();
    expect((await ix.cursor()).events).toBeGreaterThanOrEqual(before);
    const again = await verify(pool, source, d, { state: source.client });
    expect(again.problems).toEqual([]);
  }, 300_000);
});
