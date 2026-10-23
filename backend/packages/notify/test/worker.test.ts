import { randomUUID } from "node:crypto";
import fc from "fast-check";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Locale } from "../src/events.ts";
import { MockProvider, type LookupFault, type MockProviderOptions, type SendFault } from "../src/providers.ts";
import { enqueue, NotifyService, operatorDecide, type EnqueueInput } from "../src/service.ts";
import { NotifyWorker, type NotifyWorkerOptions } from "../src/worker.ts";
import { servicePool } from "../../db/test/helpers.ts";
import { contacts, fastForward, investor, makeNotifyDb, type NotifyDb } from "./helpers.ts";

/** Delivery worker: record before send, retries, dead letters, rate limits, crash recovery (N-5..N-7). */

let t: NotifyDb;
let db: pg.Pool;
/** The worker connects as a login in pt_svc_notify (T-012, migration 0029), as in production; `db` (admin) produces. */
let workerDb: Awaited<ReturnType<typeof servicePool>>;
let svc: NotifyService;
const AT = "2026-10-13T09:00:00Z";

beforeAll(async () => {
  t = await makeNotifyDb();
  db = t.pool;
  workerDb = await servicePool("notify", String(t.settings.database), 8);
  svc = new NotifyService(db, t.secrets);
  // Most tests send many messages to few people; the rate-limit test sets its own cap.
  await db.query("UPDATE notify.rate_limits SET max_per_hour = 1000");
}, 120_000);

afterAll(async () => {
  await workerDb.drop();
  await t.drop();
}, 120_000);

interface Person {
  ref: { type: "investor"; id: string };
  id: string;
  phone: string;
  email: string;
}

async function person(locale: Locale = "en", channels: ("sms" | "email")[] = ["sms", "email"]): Promise<Person> {
  const ref = investor();
  const id = await svc.registerRecipient(ref, locale, "web");
  const c = contacts();
  if (channels.includes("sms")) await svc.registerContact(id, "sms", c.phone, "web");
  if (channels.includes("email")) await svc.registerContact(id, "email", c.email, "web");
  return { ref, id, ...c };
}

function worker(providers: NotifyWorkerOptions["providers"], extra: Partial<NotifyWorkerOptions> = {}): NotifyWorker {
  return new NotifyWorker(workerDb.pool, {
    workerId: `w-${randomUUID().slice(0, 8)}`,
    providers,
    secrets: t.secrets,
    leaseSeconds: 30,
    sendTimeoutMs: 5_000,
    ...extra,
  });
}

function mocks(opts: MockProviderOptions = {}): { sms: MockProvider; email: MockProvider } {
  return { sms: new MockProvider("sms", opts), email: new MockProvider("email", opts) };
}

interface Delivery {
  id: string;
  uid: string;
  channel: string;
  status: string;
  attempts: number;
  provider_message_id: string | null;
  last_error: string | null;
  due_in: number;
}

async function deliveries(notificationId: bigint): Promise<Delivery[]> {
  const { rows } = await db.query<Delivery>(
    `SELECT id, uid, channel, status, attempts, provider_message_id, last_error, extract(epoch FROM available_at - now())::float8 AS due_in
     FROM notify.deliveries WHERE notification_id = $1 ORDER BY id`,
    [notificationId.toString()],
  );
  return rows;
}

const send = (p: Person, event: EnqueueInput["event"]): Promise<bigint> => enqueue(db, { key: `test:${randomUUID()}`, event, recipient: p.ref, actor: "test" });

/** Runs passes until nothing is claimed (bounded). */
async function drain(w: NotifyWorker): Promise<void> {
  for (let i = 0; i < 20 && (await w.runOnce()) > 0; i++);
}

describe("delivery", () => {
  it("sends SMS and e-mail once each, to the right contact, in the recipient's language, and records the evidence", async () => {
    const p = await person("ur");
    const id = await send(p, { kind: "security.payout_account_changed", params: { last4: "1234", previous_last4: "9876", active_from: "2026-10-16T09:00:00Z" } });
    const m = mocks();
    await drain(worker(m));
    const ds = await deliveries(id);
    expect(ds.map((d) => d.status)).toEqual(["sent", "sent"]);
    expect(m.sms.sent).toHaveLength(1);
    expect(m.email.sent).toHaveLength(1);
    const sms = m.sms.sent[0];
    const mail = m.email.sent[0];
    expect(sms?.to).toBe(`+92${p.phone.slice(1)}`);
    expect(mail?.to).toBe(p.email);
    expect(sms?.text).toMatch(/^پراپرٹی ٹوکن/);
    expect(sms?.text).toContain("\u20661234\u2069");
    expect(mail?.html).toContain('dir="rtl"');
    expect(ds.find((d) => d.channel === "sms")?.provider_message_id).toBe(sms?.messageId);
    const { rows } = await db.query<{ outcome: string; has_sha: boolean }>(
      "SELECT outcome, body_sha256 IS NOT NULL AS has_sha FROM notify.attempts WHERE delivery_id = ANY($1::bigint[])",
      [ds.map((d) => d.id)],
    );
    expect(rows).toEqual([
      { outcome: "accepted", has_sha: true },
      { outcome: "accepted", has_sha: true },
    ]);
    // Nothing more to do: a second pass sends nothing.
    await drain(worker(m));
    expect(m.sms.sent).toHaveLength(1);
  });

  it("wakes on NOTIFY when the producer commits", async () => {
    const m = mocks();
    const w = worker(m, { pollMs: 60_000 });
    await w.start();
    try {
      const p = await person();
      const id = await send(p, { kind: "security.new_device_sign_in", params: { device: "Chrome on Windows", at: AT } });
      // Functional bound only (no speed gate): the poll interval is a minute, so delivery within
      // this loop proves the LISTEN path.
      for (let i = 0; i < 400 && !(await deliveries(id)).every((d) => d.status === "sent"); i++) await new Promise((r) => setTimeout(r, 50));
      expect((await deliveries(id)).map((d) => d.status)).toEqual(["sent", "sent"]);
    } finally {
      await w.stop();
    }
  });
});

describe("retries and dead letters (N-6)", () => {
  it("retries a provably unaccepted send with exponential backoff, dead-letters after the last attempt, and an operator can retry it", async () => {
    const p = await person("en", ["sms"]);
    const id = await send(p, { kind: "rent.paid", params: { token: "PTK-DHA", amount_paisa: 1_000_00n, period: "2026-10" } });
    const down = mocks({ sendFault: () => "unavailable" });
    const w = worker(down);
    const delays: number[] = [];
    for (let attempt = 1; attempt <= 5; attempt++) {
      await w.runOnce();
      const [d] = await deliveries(id);
      if (attempt < 5) {
        expect(d?.status).toBe("pending");
        expect(d?.attempts).toBe(attempt);
        delays.push(Math.round(d?.due_in ?? 0));
        await fastForward(db);
      } else {
        expect(d?.status).toBe("dead");
        expect(d?.last_error).toMatch(/ProviderUnavailable/);
      }
    }
    // 30 s * 2^(attempt-1); generous bounds (seconds, not a speed gate).
    expect(delays.map((x) => Math.round(x / 10) * 10)).toEqual([30, 60, 120, 240]);
    expect(down.sms.sent).toHaveLength(0);
    const [dead] = await deliveries(id);
    expect(await operatorDecide(db, BigInt(dead?.id ?? "0"), "ops-1", "retry", "provider outage over")).toBe(true);
    await expect(operatorDecide(db, BigInt(dead?.id ?? "0"), "ops-1", "retry", "short")).rejects.toThrow();
    const up = mocks();
    await worker(up).runOnce();
    expect((await deliveries(id))[0]?.status).toBe("sent");
    expect(up.sms.sent).toHaveLength(1);
  });

  it("a permanent refusal goes straight to the dead letters; an operator can abandon it", async () => {
    const p = await person("en", ["sms"]);
    const id = await send(p, { kind: "security.account_frozen", params: { at: AT } });
    await worker(mocks({ sendFault: () => "reject" })).runOnce();
    const [d] = await deliveries(id);
    expect(d?.status).toBe("dead");
    expect(d?.attempts).toBe(1);
    expect(await operatorDecide(db, BigInt(d?.id ?? "0"), "ops-1", "abandon", "number no longer in service")).toBe(true);
    expect((await deliveries(id))[0]?.status).toBe("abandoned");
    await expect(db.query("UPDATE notify.deliveries SET status = 'pending' WHERE id = $1", [d?.id])).rejects.toThrow(/final/);
  });

  it("a message that cannot be rendered or a contact that does not open is dead-lettered before anything is sent", async () => {
    // A (deliberately broken) Urdu template longer than three SMS segments.
    await db.query("SELECT notify.add_template('security.account_unfrozen', 'sms', 'ur', NULL, $1, 'ops-test')", [`${"ا".repeat(240)} {{at}}`]);
    const ur = await person("ur", ["sms"]);
    const id = await send(ur, { kind: "security.account_unfrozen", params: { at: AT } });
    const m = mocks();
    await worker(m).runOnce();
    const [d] = await deliveries(id);
    expect(d?.status).toBe("dead");
    expect(d?.last_error).toMatch(/RenderError: SMS needs/);
    expect(m.sms.sent).toHaveLength(0);

    // A sealed contact copied onto another recipient's row (superuser, trigger off) must not open.
    const a = await person("en", ["sms"]);
    const b = await person("en", ["sms"]);
    await db.query("ALTER TABLE notify.contacts DISABLE TRIGGER contacts_guard");
    try {
      await db.query(
        `UPDATE notify.contacts SET sealed = (SELECT sealed FROM notify.contacts WHERE recipient_id = $1 AND superseded_at IS NULL)
         WHERE recipient_id = $2 AND superseded_at IS NULL`,
        [a.id, b.id],
      );
    } finally {
      await db.query("ALTER TABLE notify.contacts ENABLE TRIGGER contacts_guard");
    }
    const id2 = await send(b, { kind: "security.account_frozen", params: { at: AT } });
    await worker(m).runOnce();
    expect((await deliveries(id2))[0]).toMatchObject({ status: "dead", last_error: expect.stringMatching(/ContactError/) as unknown });
    expect(m.sms.sent.some((r) => r.to === `+92${a.phone.slice(1)}`)).toBe(false);
  });
});

describe("unknown outcomes and crashes (N-5)", () => {
  it("accepted then crashed before recording: never re-sent; resolved from the provider after the lease", async () => {
    const p = await person("en", ["sms"]);
    const id = await send(p, { kind: "security.large_transaction_pending", params: { amount_paisa: 5_000_000_00n, reference: "OUT-4821" } });
    let call = 0;
    const m = mocks({ dedupe: false, sendFault: () => (++call === 1 ? "accept_then_error" : "ok") });
    const w = worker(m);
    await w.runOnce();
    expect((await deliveries(id))[0]?.status).toBe("sending");
    await w.runOnce(); // lease still valid: untouched
    expect((await deliveries(id))[0]?.status).toBe("sending");
    await fastForward(db);
    await w.runOnce(); // re-leased for resolution: the provider says it accepted
    const [d] = await deliveries(id);
    expect(d?.status).toBe("sent");
    expect(m.sms.acceptances(d?.uid ?? "")).toBe(1);
    expect(d?.provider_message_id).toBe(m.sms.sent[0]?.messageId);
  });

  it("failed without acceptance (or timed out): resolved as not accepted and sent exactly once on retry", async () => {
    const p = await person("en", ["sms"]);
    const id = await send(p, { kind: "security.account_frozen", params: { at: AT } });
    let call = 0;
    const m = mocks({ dedupe: false, sendFault: () => (++call === 1 ? "hang" : "ok") });
    const w = worker(m, { sendTimeoutMs: 100, leaseSeconds: 11 });
    await w.runOnce(); // times out: outcome unknown
    expect((await deliveries(id))[0]?.status).toBe("sending");
    await fastForward(db);
    await w.runOnce(); // lookup: not found -> pending with backoff
    expect((await deliveries(id))[0]?.status).toBe("pending");
    await fastForward(db);
    await w.runOnce();
    const [d] = await deliveries(id);
    expect(d?.status).toBe("sent");
    expect(m.sms.acceptances(d?.uid ?? "")).toBe(1);
  });

  it("an outcome that stays unknown is dead-lettered after reviewAfterMs, never re-sent", async () => {
    const p = await person("en", ["sms"]);
    const id = await send(p, { kind: "security.account_frozen", params: { at: AT } });
    const m = mocks({ dedupe: false, sendFault: () => "error_before", lookupFault: () => "unknown" });
    const w = worker(m, { reviewAfterMs: 0 });
    await w.runOnce();
    await fastForward(db);
    await w.runOnce();
    const [d] = await deliveries(id);
    expect(d?.status).toBe("dead");
    expect(d?.last_error).toMatch(/cannot say whether it accepted/);
    expect(m.sms.sent).toHaveLength(0);
  });

  it("a worker that died after claiming leaves nothing sent; the claim expires and the delivery goes out once", async () => {
    const p = await person("en", ["sms"]);
    const id = await send(p, { kind: "security.account_frozen", params: { at: AT } });
    await db.query("SELECT * FROM notify.claim('dead-worker', 100, 60)");
    const m = mocks({ dedupe: false });
    const w = worker(m);
    await w.runOnce();
    expect((await deliveries(id))[0]?.status).toBe("claimed");
    await fastForward(db);
    await drain(w);
    const [d] = await deliveries(id);
    expect(d?.status).toBe("sent");
    expect(m.sms.acceptances(d?.uid ?? "")).toBe(1);
    // Record before send: no attempt can begin without enough lease left for the provider call.
    const p2 = await person("en", ["sms"]);
    const id2 = await send(p2, { kind: "security.account_frozen", params: { at: AT } });
    await db.query("SELECT * FROM notify.claim('slow-worker', 100, 20)");
    const [d2] = await deliveries(id2);
    const { rows } = await db.query<{ a: string | null }>("SELECT notify.begin_attempt($1, 'slow-worker', 25) AS a", [d2?.id]);
    expect(rows[0]?.a).toBeNull();
    const { rows: other } = await db.query<{ a: string | null }>("SELECT notify.begin_attempt($1, 'another-worker', 1) AS a", [d2?.id]);
    expect(other[0]?.a).toBeNull();
  });

  it("two workers racing never send the same delivery twice", async () => {
    const people = await Promise.all(Array.from({ length: 6 }, () => person()));
    const ids = await Promise.all(people.map((p) => send(p, { kind: "security.account_frozen", params: { at: AT } })));
    const m = mocks({ dedupe: false });
    const w1 = worker(m, { batch: 3 });
    const w2 = worker(m, { batch: 3 });
    for (let i = 0; i < 6; i++) await Promise.all([w1.runOnce(), w2.runOnce()]);
    for (const id of ids) {
      for (const d of await deliveries(id)) {
        expect(d.status).toBe("sent");
        expect(m.sms.acceptances(d.uid) + m.email.acceptances(d.uid)).toBe(1);
      }
    }
  });
});

describe("rate limits (N-7)", () => {
  it("defers deliveries above the hourly limit per recipient and channel without using attempts", async () => {
    await db.query("UPDATE notify.rate_limits SET max_per_hour = 2 WHERE category = 'transactional' AND channel = 'sms'");
    try {
      const p = await person("en", ["sms"]);
      const ids: bigint[] = [];
      for (let i = 0; i < 4; i++) ids.push(await send(p, { kind: "rent.paid", params: { token: "PTK-DHA", amount_paisa: BigInt(100 + i), period: `2026-0${String(i + 1)}` } }));
      const other = await person("en", ["sms"]);
      const otherId = await send(other, { kind: "rent.paid", params: { token: "PTK-DHA", amount_paisa: 1n, period: "2026-01" } });
      const m = mocks();
      await drain(worker(m));
      const state = async (): Promise<Delivery[]> => (await Promise.all(ids.map((id) => deliveries(id)))).flat();
      let all = await state();
      expect(all.filter((d) => d.status === "sent")).toHaveLength(2);
      // In the same pass the limit was taken by deliveries still in flight: re-checked in a minute.
      let deferred = all.filter((d) => d.status === "pending");
      expect(deferred).toHaveLength(2);
      for (const d of deferred) {
        expect(d.attempts).toBe(0);
        expect(d.due_in).toBeGreaterThan(30);
        expect(d.last_error).toMatch(/rate limit/);
      }
      // Due again: the two sends of this hour now hold the limit, so they wait for the window.
      await fastForward(db);
      await drain(worker(m));
      all = await state();
      expect(all.filter((d) => d.status === "sent")).toHaveLength(2);
      deferred = all.filter((d) => d.status === "pending");
      expect(deferred).toHaveLength(2);
      for (const d of deferred) {
        expect(d.attempts).toBe(0);
        expect(d.due_in).toBeGreaterThan(3000); // about an hour after the first send
      }
      expect(m.sms.sent.filter((r) => r.to === `+92${p.phone.slice(1)}`)).toHaveLength(2);
      // Another recipient is not affected.
      expect((await deliveries(otherId))[0]?.status).toBe("sent");
      // Security notices have their own, higher limit.
      const sec = await send(p, { kind: "security.account_frozen", params: { at: AT } });
      await drain(worker(m));
      expect((await deliveries(sec))[0]?.status).toBe("sent");
    } finally {
      await db.query("UPDATE notify.rate_limits SET max_per_hour = 1000");
    }
  });
});

/**
 * Property test against a reference model. Random provider faults (refused, unavailable, failing
 * before or AFTER accepting = a crash between send and record), random lookup failures, one to
 * three racing workers, and leases expiring between rounds. For every delivery:
 *   - the provider accepted it at most once (the mock does not deduplicate: worst case);
 *   - it ends sent or dead, never stuck or lost;
 *   - sent <=> the provider accepted it, with the recorded message id;
 *   - dead => the provider never accepted it.
 * Mutations that must make this fail: treating an unknown outcome as "not accepted" (retry at
 * once), or resolving a 'sending' delivery by sending again without asking the provider.
 */
describe("exactly-once property (reference model)", () => {
  const faultArb = fc.constantFrom<SendFault>("ok", "ok", "unavailable", "reject", "error_before", "accept_then_error");
  const lookupArb = fc.constantFrom<LookupFault>("ok", "ok", "ok", "unknown", "error");

  it("never sends twice and never loses a delivery", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(faultArb, { minLength: 1, maxLength: 12 }),
        fc.array(lookupArb, { minLength: 1, maxLength: 6 }),
        fc.integer({ min: 1, max: 3 }),
        fc.integer({ min: 1, max: 3 }),
        async (faults, lookups, workers, people) => {
          const ps = await Promise.all(Array.from({ length: people }, () => person()));
          const ids = await Promise.all(ps.map((p) => send(p, { kind: "security.new_device_sign_in", params: { device: "Edge on Windows", at: AT } })));
          const opts: MockProviderOptions = {
            dedupe: false,
            sendFault: (_m, n) => faults[(n - 1) % faults.length] ?? "ok",
            // Every few lookups answer truthfully, so the model always makes progress.
            lookupFault: (_k, n) => (n % 4 === 0 ? "ok" : (lookups[(n - 1) % lookups.length] ?? "ok")),
          };
          const m = mocks(opts);
          const ws = Array.from({ length: workers }, () => worker(m, { leaseSeconds: 11, sendTimeoutMs: 1_000, reviewAfterMs: 3_600_000 }));
          const mine = async (): Promise<Delivery[]> => (await Promise.all(ids.map((id) => deliveries(id)))).flat();
          for (let round = 0; round < 60; round++) {
            const open = (await mine()).filter((d) => d.status !== "sent" && d.status !== "dead");
            if (open.length === 0) break;
            if (round === 40) {
              // Calm phase: the same provider "recovers" (lookups truthful, no new faults).
              Object.assign(opts, { sendFault: () => "ok", lookupFault: () => "ok" });
            }
            await Promise.all(ws.map((w) => w.runOnce()));
            await fastForward(db);
          }
          for (const d of await mine()) {
            const accepted = m.sms.acceptances(d.uid) + m.email.acceptances(d.uid);
            expect(accepted).toBeLessThanOrEqual(1);
            expect(["sent", "dead"]).toContain(d.status);
            if (d.status === "sent") {
              expect(accepted).toBe(1);
              const rec = [...m.sms.sent, ...m.email.sent].find((r) => r.idempotencyKey === d.uid);
              expect(d.provider_message_id).toBe(rec?.messageId);
            } else {
              expect(accepted).toBe(0);
            }
          }
        },
      ),
      { numRuns: 25, seed: 0x5eed, endOnFailure: true },
    );
  }, 600_000);
});
