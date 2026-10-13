import { fileURLToPath } from "node:url";
import fc from "fast-check";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../../db/src/migrate.ts";
import { scratchDatabase } from "../../db/test/helpers.ts";
import { enqueue, getCommand, OutboxWorker, type Command } from "../src/index.ts";
import { FakeChain, type Fault } from "./fake-chain.ts";

const MIGRATIONS = fileURLToPath(new URL("../../db/migrations", import.meta.url));

let admin: pg.Client;
let pool: pg.Pool;
let drop: () => Promise<void>;
let n = 0;
const key = (label: string) => `w:${label}:${String(++n)}:${String(Date.now())}`;

beforeAll(async () => {
  let settings: pg.ClientConfig;
  ({ client: admin, settings, drop } = await scratchDatabase());
  await migrate(admin, MIGRATIONS);
  pool = new pg.Pool({ ...settings, max: 20 });
});

afterAll(async () => {
  await pool.end();
  await drop();
});

function worker(chain: FakeChain, id: string, opts: { reviewAfterMs?: number } = {}): OutboxWorker {
  return new OutboxWorker(pool, {
    workerId: id,
    executors: { "issuance.mint": chain.executor() },
    leaseSeconds: 5,
    waitMs: 50,
    reviewAfterMs: opts.reviewAfterMs ?? 60_000,
  });
}

async function add(chain: FakeChain, faults: Fault[], maxAttempts = 5): Promise<{ id: bigint; key: string }> {
  const k = key("cmd");
  chain.plan(k, faults);
  const id = await enqueue(pool, { idempotencyKey: k, kind: "issuance.mint", payload: { amount: "1" }, createdBy: "test", maxAttempts });
  return { id, key: k };
}

/** Runs workers until every given command is final or in review; leases and backoffs are fast-forwarded. */
async function drive(workers: OutboxWorker[], ids: bigint[], rounds = 30): Promise<Command[]> {
  const list = ids.map(String);
  for (let i = 0; i < rounds; i++) {
    await admin.query(
      `UPDATE outbox.commands SET available_at = now() - interval '1 second' WHERE id = ANY($1) AND status = 'pending'`,
      [list],
    );
    await Promise.all(workers.map((w) => w.runOnce()));
    const states = await Promise.all(ids.map((id) => getCommand(pool, id)));
    if (states.every((c) => c && ["confirmed", "failed", "review"].includes(c.status))) return states as Command[];
    // Anything still leased (e.g. a crashed worker's command) is handed over on the next round.
    await admin.query(
      `UPDATE outbox.commands SET lease_until = now() - interval '1 second' WHERE id = ANY($1) AND status IN ('claimed', 'submitted')`,
      [list],
    );
  }
  return (await Promise.all(ids.map((id) => getCommand(pool, id)))) as Command[];
}

describe("worker outcomes", () => {
  it("confirms a command whose transaction succeeds", async () => {
    const chain = new FakeChain();
    const c = await add(chain, ["ok"]);
    const [done] = await drive([worker(chain, "w1")], [c.id]);
    expect(done).toMatchObject({ status: "confirmed", attempts: 1 });
    expect(chain.successes(c.id)).toBe(1);
  });

  it("fails a refused command without sending anything", async () => {
    const chain = new FakeChain();
    const c = await add(chain, ["refuse"]);
    const [done] = await drive([worker(chain, "w1")], [c.id]);
    expect(done).toMatchObject({ status: "failed", tx: null });
    expect(done?.lastError).toMatch(/RefusedError/);
    expect(chain.successes(c.id)).toBe(0);
  });

  it("retries transient errors and untyped errors before recording, then succeeds", async () => {
    const chain = new FakeChain();
    const c = await add(chain, ["transient", "crashBeforeRecord", "ok"]);
    const [done] = await drive([worker(chain, "w1")], [c.id]);
    expect(done).toMatchObject({ status: "confirmed", attempts: 3 });
    expect(chain.successes(c.id)).toBe(1);
  });

  it("goes to review when out of attempts", async () => {
    const chain = new FakeChain();
    const c = await add(chain, ["transient", "transient", "transient"], 2);
    const [done] = await drive([worker(chain, "w1")], [c.id]);
    expect(done).toMatchObject({ status: "review", attempts: 2 });
  });

  it("a crash after broadcasting is settled from the chain, never sent twice", async () => {
    const chain = new FakeChain();
    const c = await add(chain, ["crashAfterBroadcast", "ok", "ok"]);
    const [done] = await drive([worker(chain, "w1"), worker(chain, "w2")], [c.id]);
    expect(done).toMatchObject({ status: "confirmed", attempts: 1 });
    expect(chain.successes(c.id)).toBe(1);
  });

  it("a transaction recorded but never sent is retried only once its nonce is provably taken", async () => {
    const chain = new FakeChain();
    const a = await add(chain, ["crashAfterRecord", "ok"]);
    // While nothing else uses the nonce the outcome is unknown, so it waits (and would go to review).
    const [waiting] = await drive([worker(chain, "w1", { reviewAfterMs: 0 })], [a.id], 3);
    expect(waiting?.status).toBe("review");
    expect(chain.successes(a.id)).toBe(0);

    const chain2 = new FakeChain();
    const b = await add(chain2, ["crashAfterRecord", "ok"]);
    const other = await add(chain2, ["ok"]); // takes the nonce b recorded but never sent
    const states = await drive([worker(chain2, "w3")], [b.id, other.id]);
    expect(states.map((s) => s.status)).toEqual(["confirmed", "confirmed"]);
    expect(chain2.successes(b.id)).toBe(1);
    expect(states[0]?.attempts).toBe(2);
  });

  it("fails a reverted transaction and keeps its hash as evidence", async () => {
    const chain = new FakeChain();
    const c = await add(chain, ["revert"]);
    const [done] = await drive([worker(chain, "w1")], [c.id]);
    expect(done?.status).toBe("failed");
    expect(done?.tx?.hash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("sends a transaction that stays pending to review, not to a second send", async () => {
    const chain = new FakeChain();
    const c = await add(chain, ["stuck", "ok"]);
    const [done] = await drive([worker(chain, "w1", { reviewAfterMs: 0 })], [c.id]);
    expect(done?.status).toBe("review");
    expect(chain.successes(c.id)).toBe(0);
    chain.mineStuck(); // the chain catches up later; operations confirm with the hash as evidence
    expect(chain.successes(c.id)).toBe(1);
  });
});

describe("property: never two successful transactions for one command", () => {
  const fault = fc.constantFrom<Fault>("ok", "refuse", "transient", "crashBeforeRecord", "crashAfterRecord", "crashAfterBroadcast", "revert");
  it("holds for random faults, commands and worker counts", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fc.array(fault, { maxLength: 4 }), { minLength: 1, maxLength: 6 }), fc.integer({ min: 1, max: 3 }), async (plans, workers) => {
        const chain = new FakeChain();
        const cmds = [];
        for (const p of plans) cmds.push(await add(chain, p));
        const ws = Array.from({ length: workers }, (_, i) => worker(chain, `p${String(i)}`, { reviewAfterMs: 0 }));
        const states = await drive(ws, cmds.map((c) => c.id), 40);
        for (const [i, c] of cmds.entries()) {
          const s = states.at(i);
          const ok = chain.successes(c.id);
          expect(ok).toBeLessThanOrEqual(1);
          if (s?.status === "confirmed") expect(ok).toBe(1);
          if (s?.status === "failed") expect(ok).toBe(0);
          expect(["confirmed", "failed", "review"]).toContain(s?.status);
        }
      }),
      { numRuns: 40 },
    );
  });
});

describe("LISTEN/NOTIFY", () => {
  it("a started worker picks up a new command immediately, without waiting for the poll", async () => {
    const chain = new FakeChain();
    const w = new OutboxWorker(pool, { workerId: "listener", executors: { "issuance.mint": chain.executor() }, pollMs: 60_000, waitMs: 50 });
    await w.start();
    try {
      await new Promise((r) => setTimeout(r, 200)); // the startup pass is over
      const started = Date.now();
      const c = await add(chain, ["ok"]);
      let status: string | undefined;
      while (Date.now() - started < 3_000) {
        status = (await getCommand(pool, c.id))?.status;
        if (status === "confirmed") break;
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(status).toBe("confirmed");
      // The poll is 60 s, so finishing well under it proves NOTIFY woke the worker. 10 s leaves room
      // for a loaded machine; the 1.5 s bound applies with PT_PERF_GATES=1 (T-001).
      expect(Date.now() - started).toBeLessThan(process.env.PT_PERF_GATES === "1" ? 1_500 : 10_000);
    } finally {
      await w.stop();
    }
  });
});
