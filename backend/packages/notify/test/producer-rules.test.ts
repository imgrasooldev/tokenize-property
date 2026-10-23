import { randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EVENT_KINDS, isEventKind, isOfficerKind, kindSpec, type Channel, type Locale } from "../src/events.ts";
import { render, WORDS } from "../src/render.ts";
import { NotifyService, verifyAudit } from "../src/service.ts";
import { contacts, investor, longest, makeNotifyDb, type NotifyDb } from "./helpers.ts";

/**
 * Migration 0030 rules that do not need a business module: template parity (EN/UR, SMS/e-mail),
 * no tipping-off in investor templates (NP-4), marketing opt-in (NP-5), rate limits for producer
 * bursts (NP-6/N-7) and "a notification never blocks the business change" (NP-3).
 */

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

interface Tpl {
  kind: string;
  channel: Channel;
  locale: Locale;
  subject: string | null;
  body: string;
  version: number;
}

async function currentTemplates(): Promise<Tpl[]> {
  const { rows } = await db.query<Tpl>(
    "SELECT DISTINCT ON (kind, channel, locale) kind, channel, locale, subject, body, version FROM notify.templates ORDER BY kind, channel, locale, version DESC",
  );
  return rows;
}

const placeholdersIn = (s: string): string[] => [...new Set([...s.matchAll(/\{\{([a-z_0-9]+)\}\}/g)].map((m) => m[1] ?? ""))].sort();

/**
 * Words an investor message must never contain (tipping-off, AML/CFT Act 2010 s.34 and the FMU
 * guidance): it must not reveal a sanctions or PEP match, a suspicious transaction report, a freeze
 * or that compliance is looking at the account. Mirrors notify.tipping_off_word (migration 0030).
 */
const FORBIDDEN_EN = /\b(sanction\w*|peps?|str|suspicious|suspicion|unfreez\w*|freez\w*|frozen|fmu|launder\w*|terror\w*|watch ?lists?|black ?list\w*|politically exposed|compliance|aml)\b/i;
const FORBIDDEN_UR = /(منجمد|مشکوک|پابندی|لانڈرنگ|دہشت|کمپلائنس)/;

describe("templates (NP-9)", () => {
  it("every kind has SMS and e-mail templates in English and Urdu with the same placeholders in both languages", async () => {
    const rows = await currentTemplates();
    for (const kind of Object.keys(EVENT_KINDS)) {
      for (const channel of ["sms", "email"] as const) {
        const en = rows.find((r) => r.kind === kind && r.channel === channel && r.locale === "en");
        const ur = rows.find((r) => r.kind === kind && r.channel === channel && r.locale === "ur");
        expect(en, `${kind} ${channel} en`).toBeDefined();
        expect(ur, `${kind} ${channel} ur`).toBeDefined();
        const text = (x: Tpl | undefined): string => `${x?.subject ?? ""} ${x?.body ?? ""}`;
        expect(placeholdersIn(text(ur)), `${kind} ${channel}: Urdu and English carry the same values`).toEqual(placeholdersIn(text(en)));
        // Every placeholder of the kind appears in the e-mail (nothing the investor needs is dropped).
        if (channel === "email") expect(placeholdersIn(text(en))).toEqual(Object.keys(kindSpec(kind as keyof typeof EVENT_KINDS).placeholders).sort());
      }
    }
  });

  it("every word a template can show has an English and an Urdu text", () => {
    for (const [kind, spec] of Object.entries(EVENT_KINDS)) {
      for (const p of Object.values(spec.placeholders) as { type: string; choices?: readonly string[] }[]) {
        for (const c of p.choices ?? []) {
          expect(Object.hasOwn(WORDS, c), `${kind}: word ${c}`).toBe(true);
          // eslint-disable-next-line security/detect-object-injection -- checked with hasOwn
          const w = WORDS[c];
          expect(w?.en.length).toBeGreaterThan(1);
          expect(w?.ur).toMatch(/[؀-ۿ]/);
        }
      }
    }
  });
});

describe("no tipping-off in investor messages (NP-4)", () => {
  it("no current investor template, rendered with every allowed word, mentions sanctions, PEP, STR, suspicion, freezes or compliance", async () => {
    const rows = await currentTemplates();
    let checked = 0;
    for (const tpl of rows) {
      if (isOfficerKind(tpl.kind)) continue;
      if (!isEventKind(tpl.kind)) throw new Error(tpl.kind);
      expect(`${tpl.subject ?? ""} ${tpl.body}`, `${tpl.kind} ${tpl.channel} ${tpl.locale} v${String(tpl.version)}`).not.toMatch(FORBIDDEN_EN);
      expect(`${tpl.subject ?? ""} ${tpl.body}`, `${tpl.kind} ${tpl.channel} ${tpl.locale}`).not.toMatch(FORBIDDEN_UR);
      for (let variant = 0; variant < 4; variant++) {
        const r = render({ ...tpl, params: longest(tpl.kind, variant) });
        expect(`${r.subject ?? ""} ${r.text}`).not.toMatch(FORBIDDEN_EN);
        expect(`${r.subject ?? ""} ${r.text}`).not.toMatch(FORBIDDEN_UR);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(100);
    // The status words investors can receive are generic.
    expect(EVENT_KINDS["security.kyc_status_changed"].placeholders.status.choices).toEqual(["verified", "expired", "action_required", "closed"]);
  });

  it("the database refuses a new investor template with such a word, in English or Urdu; officer templates may name their queue", async () => {
    await expect(db.query("SELECT notify.add_template('rent.paid', 'sms', 'en', NULL, 'Rent {{amount_paisa}} held: sanctions screening', 'ops-1')")).rejects.toThrow(
      /no tipping-off/,
    );
    await expect(db.query("SELECT notify.add_template('security.account_frozen', 'sms', 'en', NULL, 'Account FROZEN at {{at}}', 'ops-1')")).rejects.toThrow(/no tipping-off/);
    await expect(db.query("SELECT notify.add_template('security.kyc_status_changed', 'sms', 'ur', NULL, 'مشکوک لین دین {{status}}', 'ops-1')")).rejects.toThrow(/no tipping-off/);
    await expect(db.query("SELECT notify.add_template('offering.reserved', 'sms', 'en', NULL, 'Your STR was filed {{offering}} {{amount_paisa}} {{expires_at}}', 'ops-1')")).rejects.toThrow(/no tipping-off/);
    const { rows } = await db.query<{ id: string }>("SELECT notify.add_template('officer.action_waiting', 'sms', 'en', NULL, 'PT Control: {{queue}} (compliance) ref {{reference}}', 'ops-1') AS id");
    expect(Number(rows[0]?.id)).toBeGreaterThan(0);
  });
});

/** A recipient with a phone number and an e-mail address on file. */
async function person(): Promise<{ ref: { type: "investor"; id: string }; id: string }> {
  const ref = investor();
  const id = await svc.registerRecipient(ref, "en", "web");
  const c = contacts();
  await svc.registerContact(id, "sms", c.phone, "web");
  await svc.registerContact(id, "email", c.email, "web");
  return { ref, id };
}

async function produce(key: string, kind: string, subject: string, params: object): Promise<string | null> {
  const { rows } = await db.query<{ id: string | null }>("SELECT notify.produce($1, $2, 'investor', $3, $4::jsonb, 'producer:test') AS id", [key, kind, subject, JSON.stringify(params)]);
  return rows[0]?.id ?? null;
}

async function deliveryChannels(notificationId: string): Promise<string[]> {
  const { rows } = await db.query<{ channel: string }>("SELECT channel FROM notify.deliveries WHERE notification_id = $1 ORDER BY channel", [notificationId]);
  return rows.map((r) => r.channel);
}

async function statusOf(notificationId: string): Promise<string> {
  const { rows } = await db.query<{ status: string }>("SELECT status FROM notify.notifications WHERE id = $1", [notificationId]);
  return rows[0]?.status ?? "missing";
}

describe("consent (NP-5)", () => {
  it("marketing needs an opt-in per channel (default off), recorded with the consent text version; withdrawing works; security ignores opt-outs", async () => {
    const p = await person();
    const offer = { offering: "Gulberg Heights" };
    const n1 = await produce(`test:mkt:${randomUUID()}`, "marketing.offering_open", p.ref.id, offer);
    expect(await statusOf(n1 ?? "")).toBe("suppressed");
    expect(await deliveryChannels(n1 ?? "")).toEqual([]);

    await svc.setMarketingConsent(p.id, "sms", true, "mkt-2026-10", "web:investor");
    const n2 = await produce(`test:mkt:${randomUUID()}`, "marketing.offering_open", p.ref.id, offer);
    expect(await statusOf(n2 ?? "")).toBe("queued");
    expect(await deliveryChannels(n2 ?? "")).toEqual(["sms"]);
    const { rows: d } = await db.query<{ max_attempts: number; category: string }>("SELECT max_attempts, category FROM notify.deliveries WHERE notification_id = $1", [n2]);
    expect(d[0]).toEqual({ max_attempts: 3, category: "marketing" });

    await svc.setMarketingConsent(p.id, "sms", false, "mkt-2026-10", "web:investor");
    const n3 = await produce(`test:mkt:${randomUUID()}`, "marketing.offering_open", p.ref.id, offer);
    expect(await statusOf(n3 ?? "")).toBe("suppressed");

    // Transactional: SMS switched off -> e-mail only; security: both, whatever the switches say.
    await svc.setPreference(p.id, "sms", false, "web:investor");
    const tx = await produce(`test:tx:${randomUUID()}`, "offering.waitlisted", p.ref.id, offer);
    expect(await deliveryChannels(tx ?? "")).toEqual(["email"]);
    const sec = await produce(`test:sec:${randomUUID()}`, "security.passkey_added", p.ref.id, { at: "2026-10-22T09:00:00Z" });
    expect(await deliveryChannels(sec ?? "")).toEqual(["email", "sms"]);

    // Consents are append-only and audited; one written around the API is found.
    await expect(db.query("UPDATE notify.consents SET granted = true")).rejects.toThrow(/append-only/);
    await expect(db.query("DELETE FROM notify.consents")).rejects.toThrow(/append-only/);
    await expect(svc.setMarketingConsent(p.id, "sms", true, "Not A Version!", "web")).rejects.toThrow();
    expect(await verifyAudit(db)).toEqual([]);
    await db.query("INSERT INTO notify.consents (recipient_id, channel, granted, text_version, set_by) VALUES ($1, 'email', true, 'mkt-2026-10', 'rogue')", [p.id]);
    expect((await verifyAudit(db)).map((x) => x.problem)).toEqual([expect.stringMatching(/^consent \d+ has no audit entry$/)]);
  });
});

describe("rate limits for producer bursts (NP-6, N-7)", () => {
  it("over the hourly limit a delivery is deferred, never dropped; marketing has its own lower limit", async () => {
    const p = await person();
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) {
      ids.push((await produce(`test:burst:${randomUUID()}`, "rent.paid", p.ref.id, { token: "PT-ABCDEF", amount_paisa: String(1000 + i), period: "2026-10" })) ?? "");
    }
    const q = await person();
    await svc.setMarketingConsent(q.id, "email", true, "mkt-2026-10", "web:investor");
    for (let i = 0; i < 3; i++) await produce(`test:burst-mkt:${randomUUID()}`, "marketing.offering_open", q.ref.id, { offering: `Tower ${String(i)}` });
    const { rows: claimed } = await db.query<{ recipient_id: string; channel: string; category: string }>("SELECT recipient_id, channel, category FROM notify.claim('test-worker', 100, 60)");
    const mine = claimed.filter((c) => c.recipient_id === p.id);
    expect(mine.filter((c) => c.channel === "sms")).toHaveLength(5);
    expect(mine.filter((c) => c.channel === "email")).toHaveLength(7);
    expect(claimed.filter((c) => c.recipient_id === q.id && c.category === "marketing")).toHaveLength(2);
    const waiting = async (id: string): Promise<number> =>
      (
        await db.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM notify.deliveries WHERE recipient_id = $1 AND status = 'pending' AND available_at > now() AND last_error LIKE 'rate limit%'",
          [id],
        )
      ).rows[0]?.n ?? -1;
    expect(await waiting(p.id)).toBe(2);
    expect(await waiting(q.id)).toBe(1);
    const { rows: all } = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM notify.deliveries WHERE recipient_id = ANY ($1::uuid[])", [[p.id, q.id]]);
    expect(all[0]?.n).toBe(7 + 7 + 3);
  });
});

describe("a notification never blocks the business change (NP-3)", () => {
  it("a bad value or a key conflict is recorded, audited and alerted; the surrounding transaction commits", async () => {
    const listener = await db.connect();
    const alerts: string[] = [];
    listener.on("notification", (n) => {
      if (n.channel === "notify_alert" && n.payload) alerts.push(n.payload);
    });
    await listener.query("LISTEN notify_alert");
    const p = await person();
    const key = `test:np3:${randomUUID()}`;
    const c = await db.connect();
    try {
      await c.query("BEGIN");
      await c.query("CREATE TEMP TABLE business_change (x int) ON COMMIT DROP");
      await c.query("INSERT INTO business_change VALUES (1)");
      const bad = await c.query<{ id: string | null }>("SELECT notify.produce($1, 'offering.waitlisted', 'investor', $2, '{\"offering\": \"03001234567\"}'::jsonb, 'producer:test') AS id", [
        key,
        p.ref.id,
      ]);
      expect(bad.rows[0]?.id).toBeNull();
      const ok = await c.query<{ id: string | null }>("SELECT notify.produce($1, 'offering.waitlisted', 'investor', $2, '{\"offering\": \"Tower A\"}'::jsonb, 'producer:test') AS id", [
        key,
        p.ref.id,
      ]);
      expect(ok.rows[0]?.id).not.toBeNull();
      const conflict = await c.query<{ id: string | null }>("SELECT notify.produce($1, 'offering.waitlisted', 'investor', $2, '{\"offering\": \"Tower B\"}'::jsonb, 'producer:test') AS id", [
        key,
        p.ref.id,
      ]);
      expect(conflict.rows[0]?.id).toBeNull();
      const { rows } = await c.query<{ n: number }>("SELECT count(*)::int AS n FROM business_change");
      expect(rows[0]?.n).toBe(1);
      await c.query("COMMIT");
    } finally {
      c.release();
    }
    const { rows: failures } = await db.query<{ sqlstate: string; kind: string }>("SELECT sqlstate, kind FROM notify.producer_failures WHERE idempotency_key = $1 ORDER BY id", [key]);
    expect(failures).toEqual([
      { sqlstate: "23514", kind: "offering.waitlisted" },
      { sqlstate: "23505", kind: "offering.waitlisted" },
    ]);
    for (let i = 0; i < 200 && alerts.filter((a) => a.includes("producer_failed")).length < 2; i++) await new Promise((r) => setTimeout(r, 25));
    expect(alerts.filter((a) => a.includes("producer_failed")).length).toBeGreaterThanOrEqual(2);
    await listener.query("UNLISTEN notify_alert");
    listener.release();
    await expect(db.query("DELETE FROM notify.producer_failures")).rejects.toThrow(/append-only/);
    expect((await verifyAudit(db)).filter((x) => !x.problem.startsWith("consent"))).toEqual([]);
  });
});
