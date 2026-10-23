import { randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EVENT_KINDS, isEventKind, type Channel, type Locale } from "../src/events.ts";
import { render, SMS_MAX_SEGMENTS } from "../src/render.ts";
import { enqueue, NotifyError, NotifyService, verifyAudit } from "../src/service.ts";
import { contacts, investor, longest, makeNotifyDb, type NotifyDb } from "./helpers.ts";

/** Migration 0017 rules N-1..N-4, N-8, N-9 against a scratch database (no worker involved). */

let t: NotifyDb;
let db: pg.Pool;
let svc: NotifyService;

beforeAll(async () => {
  t = await makeNotifyDb();
  db = t.pool;
  svc = new NotifyService(db, t.secrets);
}, 120_000);

afterAll(async () => {
  await t.drop();
}, 120_000);

const AT = "2026-10-13T09:00:00Z";

async function deliveriesOf(notificationId: bigint): Promise<{ channel: string; contact_id: string; status: string; category: string }[]> {
  const { rows } = await db.query<{ channel: string; contact_id: string; status: string; category: string }>(
    "SELECT channel, contact_id, status, category FROM notify.deliveries WHERE notification_id = $1 ORDER BY id",
    [notificationId.toString()],
  );
  return rows;
}

async function statusOf(notificationId: bigint): Promise<string> {
  const { rows } = await db.query<{ status: string }>("SELECT status FROM notify.notifications WHERE id = $1", [notificationId.toString()]);
  return rows[0]?.status ?? "missing";
}

/** A recipient with a phone number and an e-mail address on file. */
async function person(locale: Locale = "en"): Promise<{ ref: { type: "investor"; id: string }; id: string; phone: string; email: string }> {
  const ref = investor();
  const id = await svc.registerRecipient(ref, locale, "web");
  const c = contacts();
  await svc.registerContact(id, "sms", c.phone, "web");
  await svc.registerContact(id, "email", c.email, "web");
  return { ref, id, ...c };
}

describe("catalogue and templates", () => {
  it("TypeScript catalogue equals notify.event_kinds", async () => {
    const { rows } = await db.query<{ kind: string; category: string; placeholders: unknown }>("SELECT kind, category, placeholders FROM notify.event_kinds ORDER BY kind");
    const fromDb = Object.fromEntries(rows.map((r) => [r.kind, { category: r.category, placeholders: r.placeholders }]));
    expect(fromDb).toEqual(JSON.parse(JSON.stringify(EVENT_KINDS)));
  });

  it("every kind has SMS and e-mail templates in English and Urdu that render with the longest values and fit the SMS limit", async () => {
    const { rows } = await db.query<{ kind: string; channel: Channel; locale: Locale; subject: string | null; body: string }>(
      // The current version of each template (0030 adds version 2 of two security templates).
      "SELECT DISTINCT ON (kind, channel, locale) kind, channel, locale, subject, body FROM notify.templates ORDER BY kind, channel, locale, version DESC",
    );
    const kinds = Object.keys(EVENT_KINDS);
    expect(rows.length).toBe(kinds.length * 4);
    let longestSms = 0;
    for (const tpl of rows) {
      if (!isEventKind(tpl.kind)) throw new Error(tpl.kind);
      for (let variant = 0; variant < 4; variant++) {
        const r = render({ ...tpl, params: longest(tpl.kind, variant) });
        expect(r.text.length).toBeGreaterThan(10);
        if (tpl.channel === "sms") {
          expect(r.segments, `${tpl.kind} ${tpl.locale}`).toBeLessThanOrEqual(SMS_MAX_SEGMENTS);
          longestSms = Math.max(longestSms, r.segments ?? 0);
        } else {
          expect(r.subject).toBeTruthy();
          expect(r.html).toContain(`lang="${tpl.locale}"`);
        }
        // No links in any message (phishing defence).
        expect(r.text).not.toMatch(/https?:|www\./i);
      }
    }
    expect(longestSms).toBeGreaterThan(0);
  });

  it("adds versions; refuses foreign or malformed placeholders; templates are append-only", async () => {
    const { rows } = await db.query<{ id: string }>("SELECT notify.add_template('rent.paid', 'sms', 'en', NULL, 'Rent {{amount_paisa}} paid for {{token}}.', 'ops-1') AS id");
    const { rows: v } = await db.query<{ version: number }>("SELECT version FROM notify.templates WHERE id = $1", [rows[0]?.id]);
    expect(v[0]?.version).toBe(2);
    await expect(db.query("SELECT notify.add_template('rent.paid', 'sms', 'en', NULL, 'Hello {{name}}', 'ops-1')")).rejects.toThrow(/not a placeholder/);
    await expect(db.query("SELECT notify.add_template('rent.paid', 'sms', 'en', NULL, 'Hello {{token}', 'ops-1')")).rejects.toThrow(/malformed/);
    await expect(db.query("SELECT notify.add_template('rent.paid', 'email', 'en', NULL, 'x', 'ops-1')")).rejects.toThrow(/check constraint/);
    await expect(db.query("SELECT notify.add_template('rent.paid', 'email', 'en', E'a\\nBcc: x', 'x', 'ops-1')")).rejects.toThrow(/check constraint/);
    await expect(db.query("UPDATE notify.templates SET body = 'changed' WHERE kind = 'rent.paid'")).rejects.toThrow(/append-only/);
    await expect(db.query("DELETE FROM notify.templates WHERE kind = 'rent.paid'")).rejects.toThrow(/append-only/);
  });
});

describe("enqueue (N-2, N-4)", () => {
  it("fans out to every current contact, binds the template version, and is idempotent per key", async () => {
    const p = await person();
    const key = `test:frozen:${randomUUID()}`;
    const event = { kind: "security.account_frozen", params: { at: AT } } as const;
    const id = await enqueue(db, { key, event, recipient: p.ref, actor: "kyc-service" });
    const ds = await deliveriesOf(id);
    expect(ds.map((d) => d.channel).sort()).toEqual(["email", "sms"]);
    expect(ds.every((d) => d.status === "pending" && d.category === "security")).toBe(true);
    // Same key, same event: the same notification, no new deliveries.
    expect(await enqueue(db, { key, event, recipient: p.ref, actor: "kyc-service" })).toBe(id);
    expect((await deliveriesOf(id)).length).toBe(2);
    // Same key, anything different: refused.
    await expect(enqueue(db, { key, event: { kind: "security.account_frozen", params: { at: "2026-10-14T09:00:00Z" } }, recipient: p.ref, actor: "kyc-service" })).rejects.toMatchObject({
      code: "IDEMPOTENCY_CONFLICT",
    });
  });

  it("rolls back with the business transaction", async () => {
    const p = await person();
    const key = `test:rollback:${randomUUID()}`;
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await enqueue(client, { key, event: { kind: "security.account_unfrozen", params: { at: AT } }, recipient: p.ref, actor: "kyc-service" });
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
    const { rows } = await db.query("SELECT 1 FROM notify.notifications WHERE idempotency_key = $1", [key]);
    expect(rows.length).toBe(0);
  });

  it("the database refuses personal data in parameters even when the TypeScript checks are bypassed", async () => {
    const p = await person();
    const call = (params: object): Promise<unknown> =>
      db.query("SELECT notify.enqueue($1, 'security.new_device_sign_in', 'investor', $2, $3::jsonb, 'web')", [`test:pii:${randomUUID()}`, p.ref.id, JSON.stringify(params)]);
    await expect(call({ device: "Chrome", at: AT, name: "Ali Khan" })).rejects.toThrow(/not a placeholder/);
    await expect(call({ device: "ali@example.pk", at: AT })).rejects.toThrow(/plain label/);
    await expect(call({ device: "Phone 03001234567", at: AT })).rejects.toThrow(/digit runs/);
    await expect(call({ device: "Chrome", at: "2026-13-45T99:00:00Z" })).rejects.toThrow(/valid time/);
    await expect(call({ device: "Chrome" })).rejects.toThrow(/missing/);
    await expect(call({ device: 5, at: AT })).rejects.toThrow(/string/);
    await expect(
      db.query("SELECT notify.enqueue($1, 'security.kyc_status_changed', 'investor', $2, $3::jsonb, 'kyc')", [`test:pii:${randomUUID()}`, p.ref.id, JSON.stringify({ status: "sanctions_hit" })]),
    ).rejects.toThrow(/one of/);
    await expect(db.query("SELECT notify.enqueue($1, 'no.such_kind', 'investor', $2, '{}'::jsonb, 'web')", [`test:pii:${randomUUID()}`, p.ref.id])).rejects.toThrow(/unknown event kind/);
    // Recipients are subject ids, never names or contacts.
    await expect(enqueue(db, { key: `test:pii:${randomUUID()}`, event: { kind: "security.account_frozen", params: { at: AT } }, recipient: { type: "investor", id: "Ali Khan" }, actor: "x" })).rejects.toBeInstanceOf(
      NotifyError,
    );
    await expect(db.query("SELECT notify.register_recipient('officer', 'ali@example.pk', 'en', 'x')")).rejects.toThrow(/check constraint/);
  });
});

describe("consent (N-3)", () => {
  it("transactional notices follow per-channel preferences; security notices ignore opt-outs", async () => {
    const p = await person();
    await svc.setPreference(p.id, "sms", false, "investor");
    const rent = await enqueue(db, { key: `test:rent:${randomUUID()}`, event: { kind: "rent.paid", params: { token: "PTK-GULBERG", amount_paisa: 250_000n, period: "2026-10" } }, recipient: p.ref, actor: "bank" });
    expect((await deliveriesOf(rent)).map((d) => d.channel)).toEqual(["email"]);
    const frozen = await enqueue(db, { key: `test:sec:${randomUUID()}`, event: { kind: "security.account_frozen", params: { at: AT } }, recipient: p.ref, actor: "kyc" });
    expect((await deliveriesOf(frozen)).map((d) => d.channel).sort()).toEqual(["email", "sms"]);
    // Everything off: transactional is suppressed (recorded), security still goes out.
    await svc.setPreference(p.id, "email", false, "investor");
    const rent2 = await enqueue(db, { key: `test:rent:${randomUUID()}`, event: { kind: "rent.paid", params: { token: "PTK-GULBERG", amount_paisa: 1n, period: "2026-11" } }, recipient: p.ref, actor: "bank" });
    expect(await statusOf(rent2)).toBe("suppressed");
    expect((await deliveriesOf(rent2)).length).toBe(0);
    const sec2 = await enqueue(db, { key: `test:sec:${randomUUID()}`, event: { kind: "security.payout_account_active", params: { last4: "4321" } }, recipient: p.ref, actor: "bank" });
    expect((await deliveriesOf(sec2)).length).toBe(2);
    // Turning it back on works; the history stays (append-only preferences).
    await svc.setPreference(p.id, "email", true, "investor");
    const { rows } = await db.query("SELECT count(*)::int AS n FROM notify.preferences WHERE recipient_id = $1", [p.id]);
    expect(rows[0]).toEqual({ n: 3 });
  });

  it("a security notice for someone without contacts is recorded as undeliverable and alerts; never dropped", async () => {
    const listener = await db.connect();
    const alerts: string[] = [];
    listener.on("notification", (n) => {
      if (n.channel === "notify_alert" && n.payload) alerts.push(n.payload);
    });
    await listener.query("LISTEN notify_alert");
    try {
      const nobody = investor();
      const id = await enqueue(db, { key: `test:none:${randomUUID()}`, event: { kind: "security.new_device_sign_in", params: { device: "Firefox on Linux", at: AT } }, recipient: nobody, actor: "web" });
      expect(await statusOf(id)).toBe("undeliverable");
      for (let i = 0; i < 200 && !alerts.some((a) => a.includes(`"notification" : ${id.toString()}`)); i++) await new Promise((r) => setTimeout(r, 25));
      expect(alerts.some((a) => a.includes("undeliverable") && a.includes(`"notification" : ${id.toString()}`))).toBe(true);
      // A transactional notice for the same person is merely suppressed.
      const rent = await enqueue(db, { key: `test:none:${randomUUID()}`, event: { kind: "rent.paid", params: { token: "PTK", amount_paisa: 5n, period: "2026-10" } }, recipient: nobody, actor: "bank" });
      expect(await statusOf(rent)).toBe("suppressed");
    } finally {
      await listener.query("UNLISTEN notify_alert");
      listener.release();
    }
  });
});

describe("contacts (N-1, N-4)", () => {
  it("a contact change alerts the old contact too, and earlier alerts stay bound to the contact current when they were raised", async () => {
    const p = await person();
    const before = await enqueue(db, { key: `test:bind:${randomUUID()}`, event: { kind: "security.payout_account_added", params: { last4: "1111", active_from: AT } }, recipient: p.ref, actor: "bank" });
    const oldSms = (await deliveriesOf(before)).find((d) => d.channel === "sms")?.contact_id;
    const newPhone = contacts().phone;
    const newId = await svc.registerContact(p.id, "sms", newPhone, "web");
    expect(newId.toString()).not.toBe(oldSms);
    // The pending alert still goes to the number that was current when it was raised.
    expect((await deliveriesOf(before)).find((d) => d.channel === "sms")?.contact_id).toBe(oldSms);
    // contact_changed: to the replaced number, the new number and the e-mail address.
    const { rows } = await db.query<{ id: string }>("SELECT id FROM notify.notifications WHERE idempotency_key = $1", [`notify:contact-changed:${newId.toString()}`]);
    const changed = BigInt(rows[0]?.id ?? "0");
    const ds = await deliveriesOf(changed);
    expect(ds.map((d) => d.channel).sort()).toEqual(["email", "sms", "sms"]);
    expect(ds.map((d) => d.contact_id)).toContain(oldSms);
    expect(ds.every((d) => d.category === "security")).toBe(true);
    // Registering the same number again is a no-op (no alert storm).
    expect(await svc.registerContact(p.id, "sms", newPhone.replace(/^0/, "+92"), "web")).toBe(newId);
    // Contacts are never edited or deleted; push has no contacts yet.
    await expect(db.query("UPDATE notify.contacts SET sealed = sealed WHERE id = $1", [newId.toString()])).rejects.toThrow(/superseded, once/);
    await expect(db.query("DELETE FROM notify.contacts WHERE id = $1", [newId.toString()])).rejects.toThrow(/never deleted/);
    await expect(db.query("SELECT notify.register_contact($1, 'push', $2, $2, 1::smallint, 'x')", [p.id, Buffer.alloc(32)])).rejects.toThrow(/sms and email only/);
  });

  it("stores no readable phone number or e-mail address anywhere in the database (scan)", async () => {
    const people = await Promise.all([person("en"), person("ur"), person("en")]);
    for (const p of people) {
      await enqueue(db, { key: `test:scan:${randomUUID()}`, event: { kind: "security.new_device_sign_in", params: { device: "Safari on iPhone", at: AT } }, recipient: p.ref, actor: "web" });
    }
    const { rows: tables } = await db.query<{ s: string; t: string }>(
      "SELECT table_schema AS s, table_name AS t FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog', 'information_schema') AND table_type = 'BASE TABLE'",
    );
    let scanned = 0;
    const needles = people.flatMap((p) => [p.phone.slice(1), `92${p.phone.slice(1)}`, p.email, p.email.split("@")[0] ?? "x"]);
    for (const { s, t: name } of tables) {
      const { rows } = await db.query<{ r: string }>(`SELECT t::text AS r FROM "${s}"."${name}" t`);
      for (const r of rows) {
        scanned += 1;
        for (const n of needles) expect(r.r.includes(n), `${s}.${name} contains ${n}`).toBe(false);
      }
    }
    expect(scanned).toBeGreaterThan(50);
  });
});

describe("privileges (N-9)", () => {
  async function as<T>(role: string, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const c = await db.connect();
    try {
      await c.query(`SET ROLE ${role}`);
      return await fn(c);
    } finally {
      await c.query("RESET ROLE");
      c.release();
    }
  }

  it("a producer can only enqueue; only the worker receives sealed contacts; readers see no hashes", async () => {
    const p = await person();
    const id = await as("pt_notify_producer", (c) =>
      enqueue(c, { key: `test:role:${randomUUID()}`, event: { kind: "security.account_frozen", params: { at: AT } }, recipient: p.ref, actor: "bank-service" }),
    );
    expect(id > 0n).toBe(true);
    await as("pt_notify_producer", async (c) => {
      await expect(c.query("SELECT * FROM notify.contacts")).rejects.toThrow(/permission denied/);
      await expect(c.query("SELECT * FROM notify.deliveries")).rejects.toThrow(/permission denied/);
      await expect(c.query("SELECT * FROM notify.claim('w', 1, 60)")).rejects.toThrow(/permission denied/);
      await expect(c.query("SELECT notify.register_contact($1, 'sms', $2, $2, 1::smallint, 'x')", [p.id, Buffer.alloc(32)])).rejects.toThrow(/permission denied/);
      await expect(c.query("SELECT notify.enqueue_internal('k-12345678', 'security.account_frozen', $1, '{}'::jsonb, 'x', NULL)", [p.id])).rejects.toThrow(/permission denied/);
    });
    await as("pt_notify_reader", async (c) => {
      const { rows } = await c.query("SELECT * FROM notify.delivery_status LIMIT 1");
      expect(Object.keys(rows[0] as object)).not.toContain("sealed");
      await expect(c.query("SELECT * FROM notify.contacts")).rejects.toThrow(/permission denied/);
      await expect(c.query("SELECT * FROM notify.delivery_material(1, 'w')")).rejects.toThrow(/permission denied/);
      await expect(c.query("SELECT * FROM notify.templates")).rejects.toThrow(/permission denied/);
    });
    await as("pt_notify_worker", async (c) => {
      await expect(c.query("SELECT * FROM notify.contacts")).rejects.toThrow(/permission denied/);
      await expect(c.query("SELECT notify.enqueue('k-12345678', 'security.account_frozen', 'investor', $1, '{}'::jsonb, 'x')", [p.ref.id])).rejects.toThrow(/permission denied/);
      await expect(c.query("SELECT notify.operator_decide(1, 'x', 'retry', 'a long enough reason')")).rejects.toThrow(/permission denied/);
    });
    await as("pt_notify_service", async (c) => {
      await expect(c.query("SELECT * FROM notify.claim('w', 1, 60)")).rejects.toThrow(/permission denied/);
    });
  });
});

describe("append-only records and audit (N-8)", () => {
  it("refuses edits, verifies the hash chain and finds rows written around the API", async () => {
    await expect(db.query("UPDATE notify.notifications SET status = 'queued'")).rejects.toThrow(/append-only/);
    await expect(db.query("DELETE FROM notify.notifications")).rejects.toThrow(/append-only/);
    await expect(db.query("TRUNCATE notify.audit")).rejects.toThrow(/append-only/);
    await expect(db.query("UPDATE notify.recipients SET subject_id = $1", [randomUUID()])).rejects.toThrow(/only the locale/);
    await expect(db.query("DELETE FROM notify.deliveries")).rejects.toThrow(/never deleted/);
    await expect(db.query("UPDATE notify.deliveries SET channel = 'email'")).rejects.toThrow(/immutable/);
    await expect(db.query("UPDATE notify.deliveries SET status = 'sent'")).rejects.toThrow();
    expect(await verifyAudit(db)).toEqual([]);

    // A recipient inserted around the API, then an audit row edited with the trigger off (superuser).
    const rogue = randomUUID();
    await db.query("INSERT INTO notify.recipients (subject_type, subject_id, created_by) VALUES ('investor', $1, 'rogue')", [rogue]);
    await db.query("ALTER TABLE notify.audit DISABLE TRIGGER audit_no_change");
    try {
      await db.query("UPDATE notify.audit SET actor = 'someone-else' WHERE id = (SELECT min(id) + 3 FROM notify.audit)");
    } finally {
      await db.query("ALTER TABLE notify.audit ENABLE TRIGGER audit_no_change");
    }
    const problems = await verifyAudit(db);
    expect(problems.map((p) => p.problem)).toEqual(expect.arrayContaining(["content does not match its hash", expect.stringMatching(/^recipient .* has no audit entry$/)]));
  });
});
