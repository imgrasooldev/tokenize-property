/**
 * Indexer speed on synthetic data at scale (LOCAL DEV ONLY; uses a throw-away database):
 *   npm run indexer:bench                     # 100,000 transfers among 10,000 holders
 *   npm run indexer:bench -- 300000 20000     # transfers, holders
 * Measures the write path (decode + apply_batch, events per second) and read latency of the
 * queries in queries.ts once the tables are large. The real-chain numbers come from
 * packages/indexer/test/local-chain.test.ts.
 */
import pg from "pg";
import { Indexer } from "../src/indexer.ts";
import { distributionsOf, holders, portfolio, transfersOf } from "../src/queries.ts";
import { FakeChain, fakeDeployment, type FakeEvent } from "../test/fake-chain.ts";
import { migratedDatabase } from "../test/helpers.ts";

const transfers = Number(process.argv[2] ?? 100_000);
const holderCount = Number(process.argv[3] ?? 10_000);
const PER_BLOCK = 20;
const ZERO = `0x${"0".repeat(40)}`;
const wallet = (i: number): string => `0x${(0xb0000000 + i).toString(16).padStart(40, "0")}`;

const { settings, drop } = await migratedDatabase();
const pool = new pg.Pool({ ...settings, max: 8 });
try {
  const chain = new FakeChain();
  const d = fakeDeployment(1n);
  let t = performance.now();
  // Every holder gets a mint first, then random transfers of 1 unit between holders.
  let block: FakeEvent[] = [];
  const flush = (): void => {
    chain.mine(d, block);
    block = [];
  };
  for (let i = 0; i < holderCount; i++) {
    block.push({ role: "token", name: "Transfer", args: { from: ZERO, to: wallet(i), value: 1_000_000n } });
    if (block.length === PER_BLOCK) flush();
  }
  let seed = 42;
  const rnd = (n: number): number => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return seed % n;
  };
  for (let i = 0; i < transfers; i++) {
    block.push({ role: "token", name: "Transfer", args: { from: wallet(rnd(holderCount)), to: wallet(rnd(holderCount)), value: 1n } });
    if (block.length === PER_BLOCK) flush();
  }
  for (let i = 0; i < 50; i++) {
    block.push({ role: "distributions", name: "DistributionPublished", args: {
      id: BigInt(i + 1), token: d.contracts.token, recordBlock: 1n, merkleRoot: `0x${"ab".repeat(32)}`, totalPaisa: 1_000n, statementHash: `0x${"cd".repeat(32)}`,
    } });
  }
  flush();
  const events = holderCount + transfers + 50;
  console.log(`synthetic chain: ${chain.tip.toString()} blocks, ${String(events)} events (built in ${((performance.now() - t) / 1000).toFixed(1)} s)`);

  let last = performance.now();
  const ix = new Indexer(pool, chain, d, {
    maxEventsPerBatch: Number(process.env.BENCH_MAX_EVENTS ?? 5_000),
    onBatch: (b) => {
      if (process.env.BENCH_VERBOSE) console.log(`  batch ${b.from.toString()}-${b.to.toString()}: ${String(b.events)} events, ${(performance.now() - last).toFixed(0)} ms`);
      last = performance.now();
    },
  });
  await ix.register();
  t = performance.now();
  const r = await ix.catchUp();
  const s = (performance.now() - t) / 1000;
  console.log(`apply: ${String(r.events)} events in ${String(r.batches)} batches, ${s.toFixed(1)} s = ${Math.round(r.events / s).toString()} events/s`);

  const lat = async (name: string, fn: () => Promise<unknown>): Promise<void> => {
    await fn();
    const times: number[] = [];
    for (let i = 0; i < 300; i++) {
      const a = performance.now();
      await fn();
      times.push(performance.now() - a);
    }
    times.sort((x, y) => x - y);
    const p = (q: number): string => (times[Math.floor(q * times.length)] ?? NaN).toFixed(2);
    console.log(`read ${name.padEnd(14)} p50 ${p(0.5)} ms · p95 ${p(0.95)} ms · p99 ${p(0.99)} ms`);
  };
  let k = 0;
  const reads = async (): Promise<void> => {
    await lat("holders top 50", () => holders(pool, d.contracts.token, 50));
    await lat("portfolio", () => portfolio(pool, wallet(k++ % holderCount)));
    await lat("transfers 50", () => transfersOf(pool, wallet(k++ % holderCount), 50));
    await lat("distributions", () => distributionsOf(pool, d.contracts.token, 50));
  };
  // Right after a burst of updates (dead row versions not yet cleaned), then in steady state
  // (autovacuum has run; simulated with VACUUM ANALYZE).
  await pool.query("ANALYZE");
  console.log("reads right after the burst:");
  await reads();
  await pool.query("VACUUM ANALYZE");
  console.log("reads after VACUUM ANALYZE:");
  await reads();
} finally {
  await pool.end();
  await drop();
}
