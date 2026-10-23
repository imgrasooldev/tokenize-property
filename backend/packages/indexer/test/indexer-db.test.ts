import fc from "fast-check";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Deployment } from "../src/deployment.ts";
import { HaltedError, Indexer, InvariantViolationError, MAX_WINDOW, type IndexerOptions } from "../src/indexer.ts";
import { FakeChain, fakeDeployment, type FakeEvent, type FakeRawEvent } from "./fake-chain.ts";
import { actual, expected, indexerPool, migratedDatabase } from "./helpers.ts";
import { scenario, type Op } from "./scenario.ts";

/**
 * The indexer against a scratch PostgreSQL database and an in-memory chain. All deployments in
 * this file share ONE growing fake chain (one database indexes one network): each test mines its
 * own blocks on top and registers a fresh deployment that starts there.
 */
let admin: pg.Client;
let settings: pg.ClientConfig;
let pool: pg.Pool;
let dropPool: () => Promise<void>;
let drop: () => Promise<void>;
const chain = new FakeChain();

beforeAll(async () => {
  ({ admin, settings, drop } = await migratedDatabase());
  ({ pool, drop: dropPool } = await indexerPool(settings, 12));
});

afterAll(async () => {
  await dropPool();
  await drop();
});

/** A fresh deployment starting at the next block, with its transactions mined `perBlock` at a time. */
function deploy(txs: (FakeEvent | FakeRawEvent)[][], perBlock = 1): Deployment {
  const d = fakeDeployment(chain.tip + 1n);
  for (let i = 0; i < txs.length; i += perBlock) chain.mine(d, txs.slice(i, i + perBlock).flat());
  if (txs.length === 0) chain.mineEmpty(1);
  return d;
}

async function indexer(d: Deployment, opts: IndexerOptions = {}): Promise<Indexer> {
  const ix = new Indexer(pool, chain, d, opts);
  await ix.register();
  return ix;
}

async function expectMatches(d: Deployment): Promise<void> {
  const cursor = await (await indexer(d)).cursor();
  expect(await actual(admin, d)).toEqual(await expected(chain, d, cursor.blockNumber));
}

const ops = (list: [number, number, number, number][]): Op[] => list.map(([kind, a, b, amount]) => ({ kind, a, b, amount }));
/** One of every kind, twice, so each derivation path runs. */
const everything = ops(Array.from({ length: 30 }, (_, i) => [i % 15, i, i * 7 + 1, 100 + i] as [number, number, number, number]));

async function rejectsWithCode(p: Promise<unknown>, code: string): Promise<void> {
  await expect(p).rejects.toSatisfy((e: unknown) => (e as { code?: string }).code === code);
}

describe("C-1..C-7 database rules", () => {
  it("C-4: the writer role only calls the API; the reader only reads", async () => {
    const d = deploy(scenario(everything, "roles"));
    const ix = await indexer(d);
    await ix.catchUp();
    for (const [role, sql] of [
      ["pt_chain_writer", "INSERT INTO chain.holdings (token, holder, balance, updated_block) VALUES ($1, $1, 1, 1)"],
      ["pt_chain_writer", "UPDATE chain.tokens SET total_supply = 0 WHERE token = $1"],
      ["pt_chain_writer", "SELECT chain.clear_halt($1, 'op', 'not allowed for the writer')"],
      ["pt_chain_reader", "SELECT chain.halt($1, 'reader', 'not allowed')"],
      ["pt_chain_reader", "SELECT chain.apply_batch($1, 0, 1, null, '[]'::jsonb, '[]'::jsonb)"],
      ["pt_chain_reader", "UPDATE chain.holdings SET balance = 0 WHERE token = $1"],
    ] as const) {
      await admin.query("BEGIN");
      try {
        await admin.query(`SET LOCAL ROLE ${role}`);
        await expect(admin.query(sql, [d.contracts.token]), `${role}: ${sql}`).rejects.toThrow(/permission denied/);
      } finally {
        await admin.query("ROLLBACK");
      }
    }
    await admin.query("BEGIN");
    try {
      await admin.query("SET LOCAL ROLE pt_chain_reader");
      const { rows } = await admin.query("SELECT count(*)::int AS n FROM chain.holdings WHERE token = $1", [d.contracts.token]);
      expect((rows[0] as { n: number }).n).toBeGreaterThan(0);
    } finally {
      await admin.query("ROLLBACK");
    }
  });

  it("C-3: history is append-only and nothing can be deleted or truncated, even by the admin", async () => {
    const d = deploy(scenario(everything, "append-only"));
    await (await indexer(d)).catchUp();
    for (const sql of [
      "UPDATE chain.events SET name = 'Forged' WHERE deployment = $1",
      "DELETE FROM chain.events WHERE deployment = $1",
      "UPDATE chain.transfers SET amount = 1 WHERE deployment = $1",
      "DELETE FROM chain.issuances WHERE deployment = $1",
      "DELETE FROM chain.holdings WHERE token = (SELECT token FROM chain.tokens WHERE deployment = $1)",
      "DELETE FROM chain.cursors WHERE deployment = $1",
      "UPDATE chain.contracts SET address = '0x0000000000000000000000000000000000000bad' WHERE deployment = $1",
    ]) {
      await expect(admin.query(sql, [d.id]), sql).rejects.toThrow(/not allowed|immutable/);
    }
    await expect(admin.query("TRUNCATE chain.transfers CASCADE")).rejects.toThrow(/not allowed/);
    await expect(admin.query("UPDATE chain.blocks SET hash = hash WHERE number = (SELECT min(number) FROM chain.blocks)")).rejects.toThrow(/not allowed/);
  });

  it("C-1/C-2/C-6: apply_batch moves the cursor only by compare-and-set and only along the parent link", async () => {
    const d = deploy([]);
    const ix = await indexer(d);
    const c = await ix.cursor();
    const [next] = await chain.headers(d.fromBlock, d.fromBlock);
    if (!next) throw new Error("no block");
    const block = (parentHash: string) => JSON.stringify([{ number: next.number.toString(), hash: next.hash, parentHash, timestamp: "1" }]);
    const call = (expectedBlock: bigint, blocks: string) =>
      admin.query("SELECT chain.apply_batch($1, $2, $3, $4, $5::jsonb, '[]'::jsonb)", [d.id, expectedBlock.toString(), next.number.toString(), next.hash, blocks]);

    await rejectsWithCode(call(c.blockNumber - 1n, block(next.parentHash)), "PTC01"); // stale cursor
    await rejectsWithCode(call(c.blockNumber, block(`0x${"12".repeat(32)}`)), "PTC02"); // wrong parent
    await call(c.blockNumber, block(next.parentHash));
    await rejectsWithCode(call(c.blockNumber, block(next.parentHash)), "PTC01"); // the same batch again: refused

    await admin.query("SELECT chain.halt($1, 'test', 'operator test halt')", [d.id]);
    await rejectsWithCode(call(c.blockNumber + 1n, block(next.parentHash)), "PTC04");
    await expect(admin.query("SELECT chain.clear_halt($1, 'ops', 'short')", [d.id])).rejects.toThrow(/at least 10/);
    await admin.query("SELECT chain.clear_halt($1, 'ops-lead', 'investigated: test halt only')", [d.id]);
    const { rows } = await admin.query<{ action: string; actor: string }>("SELECT action, actor FROM chain.halts WHERE deployment = $1 ORDER BY id", [d.id]);
    expect(rows).toEqual([{ action: "halt", actor: "test" }, { action: "clear", actor: "ops-lead" }]);
  });

  it("RF-3: NULL or malformed batch arguments are refused and the cursor does not move", async () => {
    // Before migration 0008 a NULL p_events passed validation (jsonb_typeof(NULL) <> 'array' is
    // NULL, not true) and the cursor advanced past events that were never recorded.
    const d = deploy([]);
    const ix = await indexer(d);
    const c = await ix.cursor();
    const [next] = await chain.headers(d.fromBlock, d.fromBlock);
    if (!next) throw new Error("no block");
    const goodBlock = { number: next.number.toString(), hash: next.hash, parentHash: next.parentHash, timestamp: "1" };
    const call = (blocks: string | null, events: string | null, toHash: string | null = next.hash) =>
      admin.query("SELECT chain.apply_batch($1, $2, $3, $4, $5::jsonb, $6::jsonb)", [
        d.id, c.blockNumber.toString(), next.number.toString(), toHash, blocks, events,
      ]);
    const oneBlock = JSON.stringify([goodBlock]);
    const event = { blockNumber: next.number.toString(), logIndex: 0, blockHash: next.hash, address: d.contracts.token, txHash: next.hash, txIndex: 0, topics: [], data: "0x" };

    await rejectsWithCode(call(oneBlock, null), "23514"); // NULL events
    await rejectsWithCode(call(null, "[]"), "23514"); // NULL blocks
    await rejectsWithCode(call(oneBlock, "[]", null), "23514"); // NULL target hash
    await rejectsWithCode(call(JSON.stringify([{ ...goodBlock, number: undefined }]), "[]"), "23514"); // block without number
    await rejectsWithCode(call(JSON.stringify([{ ...goodBlock, timestamp: undefined }]), "[]"), "23514"); // block without timestamp
    await rejectsWithCode(call(oneBlock, JSON.stringify([{ ...event, blockNumber: undefined }])), "23514"); // event without block
    await rejectsWithCode(call(oneBlock, JSON.stringify([{ ...event, logIndex: undefined }])), "23514"); // event without log index
    await rejectsWithCode(call(oneBlock, JSON.stringify([{ ...event, blockHash: undefined }])), "23514"); // event without block hash
    expect((await ix.cursor()).blockNumber).toBe(c.blockNumber);

    await call(oneBlock, "[]"); // the well-formed batch still applies
    expect((await ix.cursor()).blockNumber).toBe(next.number);
  });

  it("registration is idempotent and refuses different settings or another chain", async () => {
    const d = deploy([]);
    await indexer(d);
    await indexer(d);
    const other = { ...d, contracts: { ...d.contracts, documents: "0x00000000000000000000000000000000000d0c00" as const } };
    await expect(new Indexer(pool, chain, other).register()).rejects.toThrow(/different settings/);
    const wrongChain = fakeDeployment(1n, 999);
    await expect(admin.query("SELECT chain.register_deployment($1, 999, 1, $2::jsonb, $3)", [wrongChain.id, JSON.stringify(wrongChain.contracts), `0x${"1".repeat(64)}`]))
      .rejects.toThrow(/another chain/);
  });

  it("C-7: NOTIFY chain_events fires only when a batch commits", async () => {
    const listener = new pg.Client(settings);
    await listener.connect();
    const seen: string[] = [];
    listener.on("notification", (m) => seen.push(m.payload ?? ""));
    await listener.query("LISTEN chain_events");
    try {
      const d = deploy(scenario(ops([[0, 1, 1, 5]]), "notify"));
      let crash = true;
      const ix = await indexer(d, { beforeCommit: () => (crash ? Promise.reject(new Error("crash before commit")) : Promise.resolve()) });
      await expect(ix.runOnce()).rejects.toThrow(/crash before commit/);
      await new Promise((r) => setTimeout(r, 100));
      expect(seen).toEqual([]);
      crash = false;
      await ix.catchUp();
      await new Promise((r) => setTimeout(r, 100));
      expect(seen.map((s) => (JSON.parse(s) as { deployment: string; events: number }))).toEqual([expect.objectContaining({ deployment: d.id, events: 2 })]);
    } finally {
      await listener.end();
    }
  });
});

describe("indexer", () => {
  it("indexes every kind of event and matches the independent reference model", async () => {
    const d = deploy(scenario(everything, "all"), 3);
    const ix = await indexer(d);
    const r = await ix.catchUp();
    expect(r.events).toBeGreaterThan(30);
    expect(await ix.runOnce()).toBeNull();
    await expectMatches(d);
    const snap = await actual(admin, d);
    expect(Object.keys(snap.distributions).length).toBeGreaterThan(0);
    expect(Object.keys(snap.documents).length).toBeGreaterThan(0);
    expect(Object.keys(snap.recoveries).length).toBeGreaterThan(0);
    expect(Object.keys(snap.investors).length).toBeGreaterThan(0);
    const raw = await admin.query("SELECT count(*)::int AS n FROM chain.events WHERE deployment = $1 AND name IS NULL", [d.id]);
    expect((raw.rows[0] as { n: number }).n).toBe(2); // the unknown logs are kept, undecoded
    const uri = await admin.query<{ uri: string }>("SELECT uri FROM chain.documents WHERE registry = $1 ORDER BY id LIMIT 1", [d.contracts.documents]);
    expect(uri.rows[0]?.uri).toMatch(/^vault:\/\/Deeds\/Doc-1\.PDF$/); // strings keep their case
  });

  it("reads at most 4,000 blocks per batch (Besu's eth_getLogs limit is 5,000)", async () => {
    expect(() => new Indexer(pool, chain, fakeDeployment(1n), { windowBlocks: 5_000 })).toThrow(/windowBlocks/);
    const d = deploy(scenario(ops([[0, 0, 0, 9]]), "window"));
    chain.mineEmpty(9_500);
    chain.mine(d, scenario(ops([[0, 1, 0, 4]]), "window-2").flat());
    const batches: bigint[] = [];
    const ix = await indexer(d, { onBatch: (b) => batches.push(b.to - b.from + 1n) });
    await ix.catchUp();
    expect(batches.every((n) => n <= BigInt(MAX_WINDOW))).toBe(true);
    expect(batches.length).toBe(3);
    await expectMatches(d);
    // Only the first and last block of each batch and blocks with events are stored.
    const stored = await admin.query("SELECT count(*)::int AS n FROM chain.blocks WHERE number BETWEEN $1 AND $2", [d.fromBlock.toString(), chain.tip.toString()]);
    expect((stored.rows[0] as { n: number }).n).toBeLessThanOrEqual(8);
  });

  it("splits a window that holds too many events", async () => {
    const d = deploy(scenario(ops(Array.from({ length: 12 }, (_, i) => [0, i, 0, 10 + i] as [number, number, number, number])), "split"), 1);
    const sizes: number[] = [];
    const ix = await indexer(d, { maxEventsPerBatch: 5, onBatch: (b) => sizes.push(b.events) });
    await ix.catchUp();
    expect(Math.max(...sizes)).toBeLessThanOrEqual(5);
    await expectMatches(d);
  });

  it("C-5: a gap in the event stream (tokens leaving a wallet that never received them) halts the indexer", async () => {
    const d = deploy([]);
    chain.mine(d, [{ role: "token", name: "Transfer", args: { from: `0x${"ab".repeat(20)}`, to: `0x${"cd".repeat(20)}`, value: 5n } }]);
    const halts: Error[] = [];
    const ix = await indexer(d, { onHalt: (e) => halts.push(e) });
    const before = await ix.cursor();
    await expect(ix.runOnce()).rejects.toBeInstanceOf(InvariantViolationError);
    const after = await ix.cursor();
    expect(after.blockNumber).toBe(before.blockNumber); // nothing of the batch was applied
    expect(after.haltReason).toMatch(/would go negative/);
    await expect(ix.runOnce()).rejects.toBeInstanceOf(HaltedError);
  });

  it("C-5: a reused refId (I-11) halts the indexer", async () => {
    const d = deploy([]);
    const refId = `0x${"77".repeat(32)}`;
    const w = `0x${"aa".repeat(20)}`;
    chain.mine(d, [{ role: "issuance", name: "Minted", args: { to: w, amount: 1n, refId } }, { role: "token", name: "Transfer", args: { from: `0x${"00".repeat(20)}`, to: w, value: 1n } }]);
    chain.mine(d, [{ role: "issuance", name: "Minted", args: { to: w, amount: 1n, refId } }]);
    const ix = await indexer(d, { windowBlocks: 1 });
    await expect(ix.catchUp()).rejects.toThrow(/used twice/);
    expect((await ix.cursor()).blockNumber).toBe(d.fromBlock + 1n); // the first mint is in, the reuse is not
  });

  it("two indexers racing on the same deployment apply every batch once", async () => {
    const d = deploy(scenario(everything, "race"), 2);
    const [a, b] = [await indexer(d, { windowBlocks: 3 }), await indexer(d, { windowBlocks: 2 })];
    for (let i = 0; i < 40; i++) await Promise.all([a.runOnce(), b.runOnce()]);
    expect((await a.cursor()).blockNumber).toBe(chain.tip);
    await expectMatches(d);
  });

  it("follow mode picks up a new block quickly, and a second follower is refused", async () => {
    const d = deploy(scenario(ops([[0, 0, 0, 1]]), "follow"));
    const ix = new Indexer(pool, chain, d, { pollMs: 50 });
    await ix.start();
    try {
      await expect(new Indexer(pool, chain, d).start()).rejects.toThrow(/already following/);
      chain.mine(d, scenario(ops([[0, 2, 0, 3]]), "follow-2").flat());
      const started = Date.now();
      while ((await ix.cursor()).blockNumber < chain.tip && Date.now() - started < 3_000) await new Promise((r) => setTimeout(r, 20));
      expect((await ix.cursor()).blockNumber).toBe(chain.tip);
      // The point is that a running follower picks the block up; the 1 s speed bound only applies
      // with PT_PERF_GATES=1 (quiet machine), because elapsed time follows machine load (T-001).
      if (process.env.PT_PERF_GATES === "1") expect(Date.now() - started).toBeLessThan(1_000);
    } finally {
      await ix.stop();
    }
    await expectMatches(d);
  });
});

describe("property: exactly once under any batching, crash and retry", () => {
  const op = fc.record({ kind: fc.nat(14), a: fc.nat(20), b: fc.nat(20), amount: fc.integer({ min: 0, max: 5_000 }) });
  const crash = fc.constantFrom("none", "none", "beforeCommit", "afterCommit", "race");
  it("random events in random batches with crashes between and inside batches give the same state, without duplicates", async () => {
    let run = 0;
    await fc.assert(
      fc.asyncProperty(
        fc.array(op, { minLength: 1, maxLength: 40 }),
        fc.integer({ min: 1, max: 4 }),
        fc.integer({ min: 1, max: 6 }),
        fc.integer({ min: 1, max: 8 }),
        fc.array(crash, { minLength: 1, maxLength: 30 }),
        async (list, perBlock, window, maxEvents, crashes) => {
          const d = deploy(scenario(list, `prop-${String(++run)}`), perBlock);
          chain.mineEmpty(window % 3); // trailing empty blocks
          let step = 0;
          let pending: string | undefined;
          const make = () => new Indexer(pool, chain, d, {
            windowBlocks: window,
            maxEventsPerBatch: maxEvents,
            beforeCommit: () => (pending === "beforeCommit" ? Promise.reject(new Error("crash: before commit")) : Promise.resolve()),
            afterCommit: () => (pending === "afterCommit" ? Promise.reject(new Error("crash: after commit, before the caller knew")) : Promise.resolve()),
          });
          let ix = make();
          await ix.register();
          for (let guard = 0; guard < 500 && (await ix.cursor()).blockNumber < chain.tip; guard++) {
            pending = crashes.at(step++) ?? "none"; // the fault plan, then a clean run to the end
            try {
              if (pending === "race") await Promise.all([ix.runOnce(), make().runOnce()]);
              else await ix.runOnce();
            } catch (e) {
              if (!(e instanceof Error) || !e.message.startsWith("crash:")) throw e;
              ix = make(); // the process "restarts": nothing is remembered but the database
            }
          }
          expect((await ix.cursor()).blockNumber).toBe(chain.tip);
          const want = await expected(chain, d, chain.tip);
          const got = await actual(admin, d);
          expect(got).toEqual(want);
          // No duplicates: one row per log, and the cursor counted each event once.
          const logs = await chain.logs(Object.values(d.contracts), d.fromBlock, chain.tip);
          expect(got.counts.events).toBe(logs.length);
          expect((await ix.cursor()).events).toBe(logs.length);
        },
      ),
      { numRuns: 40 },
    );
  }, 300_000);
});
