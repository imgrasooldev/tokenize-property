import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../../db/src/migrate.ts";
import { scratchDatabase } from "../../db/test/helpers.ts";
import { enqueue, getCommand, OutboxError } from "../src/index.ts";

const MIGRATIONS = fileURLToPath(new URL("../../db/migrations", import.meta.url));
const HASH = `0x${"ab".repeat(32)}`;
const FROM = `0x${"cd".repeat(20)}`;

let db: pg.Client;
let settings: pg.ClientConfig;
let drop: () => Promise<void>;
let n = 0;
const key = (label: string) => `test:${label}:${String(++n)}:${String(Date.now())}`;

beforeAll(async () => {
  ({ client: db, settings, drop } = await scratchDatabase());
  await migrate(db, MIGRATIONS);
});

afterAll(async () => {
  await drop();
});

async function add(label: string, extra: Partial<{ maxAttempts: number }> = {}): Promise<bigint> {
  return enqueue(db, { idempotencyKey: key(label), kind: "issuance.mint", payload: { amount: "1" }, createdBy: "test", ...extra });
}

async function claim(worker: string, batch = 1, lease = 30): Promise<{ id: string; status: string; attempts: number }[]> {
  return (await db.query<{ id: string; status: string; attempts: number }>("SELECT id, status, attempts FROM outbox.claim($1, $2, $3)", [worker, batch, lease])).rows;
}

async function status(id: bigint): Promise<string | undefined> {
  return (await getCommand(db, id))?.status;
}

async function expireLease(id: bigint): Promise<void> {
  await db.query("UPDATE outbox.commands SET lease_until = now() - interval '1 second' WHERE id = $1", [id.toString()]);
}

async function rejects(sql: string, params: unknown[] = [], pattern?: RegExp): Promise<void> {
  await expect(db.query(sql, params)).rejects.toThrow(pattern);
}

describe("O-1/O-2 enqueue", () => {
  it("is idempotent for the same command and refuses a different one under the same key", async () => {
    const k = key("idem");
    const a = await enqueue(db, { idempotencyKey: k, kind: "issuance.mint", payload: { amount: "5" }, ref: "sub-1", createdBy: "test" });
    const b = await enqueue(db, { idempotencyKey: k, kind: "issuance.mint", payload: { amount: "5" }, ref: "sub-1", createdBy: "test" });
    expect(b).toBe(a);
    await expect(enqueue(db, { idempotencyKey: k, kind: "issuance.mint", payload: { amount: "6" }, ref: "sub-1", createdBy: "test" })).rejects.toSatisfy(
      (e: unknown) => e instanceof OutboxError && e.code === "IDEMPOTENCY_CONFLICT",
    );
    await expect(enqueue(db, { idempotencyKey: k, kind: "issuance.burn", payload: { amount: "5" }, ref: "sub-1", createdBy: "test" })).rejects.toThrow();
  });

  it("disappears with the business transaction it belongs to", async () => {
    const k = key("rollback");
    await db.query("BEGIN");
    await enqueue(db, { idempotencyKey: k, kind: "issuance.mint", payload: {}, createdBy: "test" });
    await db.query("ROLLBACK");
    const { rows } = await db.query("SELECT 1 FROM outbox.commands WHERE idempotency_key = $1", [k]);
    expect(rows).toHaveLength(0);
  });

  it("validates input before and inside the database", async () => {
    await expect(enqueue(db, { idempotencyKey: "short", kind: "x", payload: {}, createdBy: "t" })).rejects.toBeInstanceOf(OutboxError);
    await expect(enqueue(db, { idempotencyKey: key("kind"), kind: "Bad Kind", payload: {}, createdBy: "t" })).rejects.toBeInstanceOf(OutboxError);
    await rejects("SELECT outbox.enqueue($1, 'issuance.mint', '[1,2]'::jsonb, null, 'test')", [key("array")]);
    await rejects("SELECT outbox.enqueue($1, 'issuance.mint', $2::jsonb, null, 'test')", [key("big"), JSON.stringify({ x: "a".repeat(20_000) })]);
  });

  it("notifies workers only when the transaction commits", async () => {
    const listener = new pg.Client(settings);
    await listener.connect();
    const seen: string[] = [];
    listener.on("notification", (m) => seen.push(m.payload ?? ""));
    await listener.query("LISTEN outbox");
    await db.query("BEGIN");
    const rolledBack = await add("notify-rb");
    await db.query("ROLLBACK");
    const committed = await add("notify-ok");
    await new Promise((r) => setTimeout(r, 300));
    await listener.end();
    expect(seen).toContain(committed.toString());
    expect(seen).not.toContain(rolledBack.toString());
  });
});

describe("O-3/O-4/O-7 immutability, transitions and history", () => {
  it("refuses changes to what a command does, deletes and truncates", async () => {
    const id = await add("immutable");
    await rejects("UPDATE outbox.commands SET payload = '{\"amount\":\"999\"}' WHERE id = $1", [id.toString()], /immutable/);
    await rejects("UPDATE outbox.commands SET kind = 'issuance.burn' WHERE id = $1", [id.toString()], /immutable/);
    await rejects("DELETE FROM outbox.commands WHERE id = $1", [id.toString()], /append-only/);
    await rejects("TRUNCATE outbox.commands CASCADE", [], /append-only/);
    await rejects("UPDATE outbox.command_events SET actor = 'x'", [], /append-only/);
  });

  it("allows only the defined status edges, and final states stay final", async () => {
    const id = await add("edges");
    await rejects("UPDATE outbox.commands SET status = 'confirmed' WHERE id = $1", [id.toString()], /not allowed/);
    await rejects("UPDATE outbox.commands SET status = 'submitted', lease_owner = 'w', lease_until = now() + interval '1 min' WHERE id = $1", [id.toString()], /not allowed/);
    const [c] = await claim("w-edges", 50);
    expect(c).toBeDefined();
    await db.query("SELECT outbox.release($1, 'w-edges', 'refused', false)", [c?.id]);
    await rejects("UPDATE outbox.commands SET status = 'pending' WHERE id = $1", [c?.id], /final/);
  });

  it("writes every change to the event history", async () => {
    const id = await add("history");
    await claim("w-hist", 50);
    const { rows } = await db.query<{ from_status: string | null; to_status: string; actor: string }>(
      "SELECT from_status, to_status, actor FROM outbox.command_events WHERE command_id = $1 ORDER BY id",
      [id.toString()],
    );
    expect(rows.map((r) => `${r.from_status ?? "-"}>${r.to_status}`)).toEqual(["->pending", "pending>claimed"]);
    expect(rows.at(-1)?.actor).toBe("w-hist");
  });
});

describe("O-5/O-6 leases and recorded transactions", () => {
  it("never hands the same command to two concurrent claimers", async () => {
    const ids = await Promise.all(Array.from({ length: 40 }, (_, i) => add(`race-${String(i)}`)));
    const pool = new pg.Pool({ ...settings, max: 10 });
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, w) =>
        pool.query<{ id: string }>("SELECT id FROM outbox.claim($1, 10, 30)", [`racer-${String(w)}`]).then((r) => r.rows.map((x) => x.id)),
      ),
    );
    await pool.end();
    const claimed = results.flat().filter((x) => ids.map(String).includes(x));
    expect(new Set(claimed).size).toBe(claimed.length);
  });

  it("records a transaction only for the current lease owner, before expiry, once", async () => {
    const id = await add("record");
    await db.query("UPDATE outbox.commands SET available_at = now() - interval '1 hour' WHERE id = $1", [id.toString()]);
    const mine = (await claim("owner", 100)).find((c) => c.id === id.toString());
    expect(mine?.status).toBe("claimed");
    const rec = (w: string, h = HASH) => db.query<{ ok: boolean }>("SELECT outbox.record_submission($1, $2, $3, 7, $4) AS ok", [id.toString(), w, h, FROM]);
    expect((await rec("intruder")).rows[0]?.ok).toBe(false);
    expect((await rec("owner")).rows[0]?.ok).toBe(true);
    expect((await rec("owner", `0x${"ef".repeat(32)}`)).rows[0]?.ok).toBe(false); // already submitted
    await rejects("UPDATE outbox.commands SET tx_hash = $2 WHERE id = $1", [id.toString(), `0x${"ef".repeat(32)}`], /transaction fields/);
    expect((await getCommand(db, id))?.tx?.hash).toBe(HASH);
  });

  it("an expired lease cannot record: the old worker must not broadcast", async () => {
    const id = await add("expired");
    await db.query("UPDATE outbox.commands SET available_at = now() - interval '2 hours' WHERE id = $1", [id.toString()]);
    await claim("slow", 100);
    await expireLease(id);
    const { rows } = await db.query<{ ok: boolean }>("SELECT outbox.record_submission($1, 'slow', $2, 1, $3) AS ok", [id.toString(), HASH, FROM]);
    expect(rows[0]?.ok).toBe(false);
    // The next claim returns it to pending and hands it out again (second attempt).
    const again = (await claim("fresh", 100)).find((c) => c.id === id.toString());
    expect(again).toMatchObject({ status: "claimed", attempts: 2 });
  });

  it("clears a transaction only when it is proven dropped, and keeps it on revert", async () => {
    const submit = async (label: string) => {
      const id = await add(label);
      await db.query("UPDATE outbox.commands SET available_at = now() - interval '3 hours' WHERE id = $1", [id.toString()]);
      await claim(`w-${label}`, 100);
      await db.query("SELECT outbox.record_submission($1, $2, $3, 3, $4)", [id.toString(), `w-${label}`, HASH, FROM]);
      return id;
    };
    const dropped = await submit("drop");
    await db.query("SELECT outbox.resolve($1, 'w-drop', 'dropped', 'nonce used')", [dropped.toString()]);
    expect(await getCommand(db, dropped)).toMatchObject({ status: "pending", tx: null });

    const reverted = await submit("revert");
    await db.query("SELECT outbox.resolve($1, 'w-revert', 'reverted', 'reverted')", [reverted.toString()]);
    expect(await getCommand(db, reverted)).toMatchObject({ status: "failed", tx: { hash: HASH } });
  });
});

describe("retries and operations", () => {
  it("backs off on transient errors, goes to review when out of attempts, fails when not retryable", async () => {
    const id = await add("retry", { maxAttempts: 2 });
    await db.query("UPDATE outbox.commands SET available_at = now() - interval '4 hours' WHERE id = $1", [id.toString()]);
    await claim("r", 100);
    const first = await db.query<{ next: string }>("SELECT outbox.release($1, 'r', 'node down', true) AS next", [id.toString()]);
    expect(first.rows[0]?.next).toBe("pending");
    const { rows } = await db.query<{ wait: number }>("SELECT extract(epoch FROM available_at - now()) AS wait FROM outbox.commands WHERE id = $1", [id.toString()]);
    expect(Number(rows[0]?.wait)).toBeGreaterThan(0);
    await db.query("UPDATE outbox.commands SET available_at = now() - interval '4 hours' WHERE id = $1", [id.toString()]);
    await claim("r", 100);
    const second = await db.query<{ next: string }>("SELECT outbox.release($1, 'r', 'node down', true) AS next", [id.toString()]);
    expect(second.rows[0]?.next).toBe("review");
  });

  it("operators decide on review with a reason; retry is refused while a transaction is recorded", async () => {
    const id = await add("operator", { maxAttempts: 1 });
    await db.query("UPDATE outbox.commands SET available_at = now() - interval '5 hours' WHERE id = $1", [id.toString()]);
    await claim("op", 100);
    await db.query("SELECT outbox.record_submission($1, 'op', $2, 9, $3)", [id.toString(), HASH, FROM]);
    await db.query("SELECT outbox.resolve($1, 'op', 'review', 'still unknown')", [id.toString()]);
    const decide = (d: string, reason = "checked on the explorer by ops") =>
      db.query<{ ok: boolean }>("SELECT outbox.operator_decide($1, 'ana', $2, $3) AS ok", [id.toString(), d, reason]);
    await rejects("SELECT outbox.operator_decide($1, 'ana', 'retry', 'short')", [id.toString()], /reason/);
    expect((await decide("retry")).rows[0]?.ok).toBe(false); // might still be mined
    expect((await decide("confirm")).rows[0]?.ok).toBe(true);
    expect(await status(id)).toBe("confirmed");
    const { rows } = await db.query<{ actor: string }>("SELECT actor FROM outbox.command_events WHERE command_id = $1 ORDER BY id DESC LIMIT 1", [id.toString()]);
    expect(rows[0]?.actor).toBe("operator:ana");
  });
});

describe("roles", () => {
  it("a writer can only enqueue; a worker cannot read or change rows directly", async () => {
    await db.query("BEGIN");
    try {
      await db.query("SET LOCAL ROLE pt_outbox_writer");
      await db.query("SELECT outbox.enqueue($1, 'issuance.mint', '{}'::jsonb, null, 'writer')", [key("role")]);
      await db.query("SAVEPOINT s");
      await expect(db.query("SELECT outbox.claim('x', 1, 30)")).rejects.toThrow(/permission denied/);
      await db.query("ROLLBACK TO SAVEPOINT s");
      await expect(db.query("SELECT * FROM outbox.commands")).rejects.toThrow(/permission denied/);
      await db.query("ROLLBACK TO SAVEPOINT s");
      await db.query("RESET ROLE");
      await db.query("SET LOCAL ROLE pt_outbox_worker");
      await expect(db.query("UPDATE outbox.commands SET status = 'confirmed'")).rejects.toThrow(/permission denied/);
    } finally {
      await db.query("ROLLBACK");
    }
  });
});
