import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { refIdFor } from "../src/service.ts";
import { ESCROW, hex32, investor, liveOffering, makeWorld, OF, pay, submittedOffering, subState, type Investor, type Offering, type World } from "./world.ts";

/**
 * Migration 0018 (WO-1..WO-6): the website's role (pt_web) and the S-02 investor functions. It can
 * read public offering data and one investor's subscriptions, accept documents, reserve (KYC-verified
 * investors only) and cancel, under `web:<id>` actors, and nothing else of the offering, KYC, bank,
 * reconciliation or property schemas.
 */

let w: World;
let web: pg.Client;
let o: Offering;
let inv: Investor;
const role = `pt_web_t_${randomBytes(4).toString("hex")}`;
const password = randomBytes(24).toString("base64url");
const actor = (): string => `web:${randomUUID()}`;

beforeAll(async () => {
  w = await makeWorld();
  await w.client.query(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD ${w.client.escapeLiteral(password)}`);
  await w.client.query(`GRANT pt_web TO ${role} WITH INHERIT TRUE, SET FALSE`);
  // Since migration 0024 (T-030) pt_web reserves and cancels only through the session-bound
  // webauth.web_reserve / web_cancel (tested in db/test/webauth.test.ts and the website's
  // integration tests). This file keeps testing the 0018 wrappers themselves, so the test login
  // gets them directly.
  await w.client.query(`GRANT EXECUTE ON FUNCTION offering.web_reserve(uuid, uuid, text, uuid, bigint, text, text), offering.web_cancel(uuid, uuid, text) TO ${role}`);
  web = new pg.Client({ ...w.settings, user: role, password });
  await web.connect();
  o = await liveOffering(w, { cap: 100n, maxUnits: 50n });
  inv = await investor(w, o.d);
}, 180_000);

afterAll(async () => {
  await web.end();
  await w.drop();
  const root = new pg.Client({ ...w.settings, database: "postgres" });
  await root.connect();
  await root.query(`DROP ROLE IF EXISTS ${role}`);
  await root.end();
}, 120_000);

async function sqlstate(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return (e as { code?: string }).code ?? "no code";
  }
  return "ok";
}

const docsAs = async (who: Investor, by: string): Promise<void> => {
  for (const [kind, sha] of [
    ["offering_document", o.docs.en],
    ["risk_disclosure", o.docs.risk],
  ] as const) {
    await web.query("SELECT offering.web_accept_document($1, $2, $3, 'en', $4, $5, $6, $7)", [o.id, who.subjectId, kind, sha, hex32(), hex32(), by]);
  }
};

const reserveAs = async (who: string, units: number, key = `web-${randomUUID()}`, by = actor()) => {
  const id = randomUUID();
  const { rows } = await web.query<{ r: { subscriptionId: string; state: string; paymentCode: string | null; amountPaisa: string; expiresAt: string | null } }>(
    "SELECT offering.web_reserve($1, $2, $3, $4, $5, $6, $7) AS r",
    [o.id, id, refIdFor(id), who, units, key, by],
  );
  const r = rows[0]?.r;
  if (!r) throw new Error("no result");
  return r;
};

describe("public offering data (WO-5)", () => {
  it("lists offerings from ready on, with public terms, aggregates and anchored hashes only", async () => {
    const draft = await submittedOffering(w);
    const { rows } = await web.query<Record<string, unknown>>("SELECT * FROM offering.web_offerings()");
    const ids = rows.map((r) => r["offering_id"]);
    expect(ids).toContain(o.id);
    expect(ids).not.toContain(draft.id);
    const { rows: one } = await web.query<Record<string, unknown>>("SELECT * FROM offering.web_offerings($1)", [o.id]);
    expect(one).toHaveLength(1);
    const r = one[0] ?? {};
    expect(r).toMatchObject({ state: "live", price_paisa: o.price.toString(), hard_cap_units: "100", max_units: "50", all_or_nothing: true, doc_en_sha: o.docs.en, risk_sha: o.docs.risk, paid_units: "0", available_units: "100" });
    // No identifiers of the parcel, the deed, the sponsor or any investor.
    expect(Object.keys(r).sort()).not.toEqual(expect.arrayContaining(["address", "plot_no", "khasra", "deed_no", "sponsor_id", "gps_lat", "subject_id"]));
    for (const k of Object.keys(r)) expect(k).not.toMatch(/address|plot|khasra|deed|sponsor|gps|subject/);
  });
});

describe("reserve, read and cancel as the website (WO-1..WO-4, WO-6)", () => {
  it("reserves for a verified investor with the backend's payment code, amount, expiry and escrow account; repeats are idempotent", async () => {
    const by = actor();
    await docsAs(inv, by);
    const key = `web-${randomUUID()}`;
    const r = await reserveAs(inv.subjectId, 10, key, by);
    expect(r.state).toBe("payment_pending");
    expect(r.paymentCode).toMatch(/^PT-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    expect(r.amountPaisa).toBe((10n * o.price).toString());
    expect(r.expiresAt).not.toBeNull();
    expect((await reserveAs(inv.subjectId, 10, key, by)).subscriptionId).toBe(r.subscriptionId);

    const { rows } = await web.query<Record<string, unknown>>("SELECT * FROM offering.web_subscriptions($1)", [inv.subjectId]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ subscription_id: r.subscriptionId, state: "payment_pending", payment_code: r.paymentCode, pay_to_account: ESCROW, units: "10", refund_status: null });
    const { rows: ev } = await web.query<{ code: string; to_state: string }>("SELECT code, to_state FROM offering.web_subscription_events($1)", [inv.subjectId]);
    expect(ev).toEqual([{ code: "V2", to_state: "payment_pending" }]);
    // Another investor's subject sees nothing of it.
    const other = await investor(w, o.d);
    expect((await web.query("SELECT * FROM offering.web_subscriptions($1)", [other.subjectId])).rows).toEqual([]);

    // Cancelling someone else's reservation is refused as unknown; the owner's cancel works.
    expect(await sqlstate(web.query("SELECT offering.web_cancel($1, $2, $3)", [r.subscriptionId, other.subjectId, actor()]))).toBe("P0002");
    const { rows: c } = await web.query<{ r: { state: string } }>("SELECT offering.web_cancel($1, $2, $3) AS r", [r.subscriptionId, inv.subjectId, by]);
    expect(c[0]?.r.state).toBe("cancelled");
    const { rows: after } = await web.query<Record<string, unknown>>("SELECT * FROM offering.web_subscriptions($1)", [inv.subjectId]);
    expect(after[0]).toMatchObject({ state: "cancelled", payment_code: null, pay_to_account: null });
    // The payment code was cancelled with the reservation (bank amendment B-8).
    const { rows: cancelled } = await w.client.query("SELECT 1 FROM bank.intent_cancellations WHERE code = $1", [r.paymentCode]);
    expect(cancelled).toHaveLength(1);
  }, 120_000);

  it("refuses a reservation unless the investor is KYC-verified now (WO-2), and other actors (WO-3)", async () => {
    const pending = await w.ikyc.onboard({ cnic: `35202${String(1_000_000 + Math.floor(Math.random() * 8_000_000))}9`, fullName: "Pending Person", livenessSessionId: "sess-good-990001" });
    expect(pending.status).not.toBe("verified");
    expect(await sqlstate(reserveAs(pending.subjectId, 10))).toBe("42501");
    expect(await sqlstate(reserveAs(randomUUID(), 10))).toBe("42501");
    const fresh = await investor(w, o.d);
    await docsAs(fresh, actor());
    for (const bad of ["system:offering-clock", OF.checker, `investor:${fresh.subjectId}`, "web:not-a-uuid"]) {
      expect(await sqlstate(reserveAs(fresh.subjectId, 10, `web-${randomUUID()}`, bad))).toBe("42501");
      expect(await sqlstate(web.query("SELECT offering.web_accept_document($1, $2, 'risk_disclosure', 'en', $3, $4, $4, $5)", [o.id, fresh.subjectId, o.docs.risk, hex32(), bad]))).toBe("42501");
    }
    // Business rules stay in offering.reserve: units outside min/max are refused there.
    expect(await sqlstate(reserveAs(fresh.subjectId, 51))).toBe("22023");
  }, 120_000);

  it("shows a blocked subscription as under review, without the internal reason (tipping-off)", async () => {
    const who = await investor(w, o.d);
    await docsAs(who, actor());
    const r = await reserveAs(who.subjectId, 10);
    await pay(w, who, r.paymentCode, BigInt(r.amountPaisa));
    expect(await subState(w, r.subscriptionId)).toBe("payment_confirmed");
    await w.of("block", { subscriptionId: r.subscriptionId, officer: OF.compliance, reason: "sanctions list possible match on the payer" });
    const { rows } = await web.query<Record<string, unknown>>("SELECT * FROM offering.web_subscriptions($1)", [who.subjectId]);
    expect(rows[0]).toMatchObject({ state: "under_review", public_reason: null, payment_code: null });
    expect(JSON.stringify(rows)).not.toMatch(/sanction|blocked/);
    const { rows: ev } = await web.query<{ to_state: string }>("SELECT to_state FROM offering.web_subscription_events($1)", [who.subjectId]);
    expect(ev.map((e) => e.to_state)).toEqual(["payment_pending", "payment_confirmed", "under_review"]);
  }, 120_000);
});

describe("nothing else (WO-1)", () => {
  it.each([
    ["read subscriptions directly", "SELECT * FROM offering.subscriptions"],
    ["read the investor view of 0015", "SELECT * FROM offering.investor_subscriptions"],
    ["read the overview", "SELECT * FROM offering.overview"],
    ["read acceptances", "SELECT * FROM offering.acceptances"],
    ["read the offering audit", "SELECT * FROM offering.audit"],
    ["read offerings directly", "SELECT * FROM offering.offerings"],
    ["write an event", "INSERT INTO offering.subscription_events (subscription_id, code, from_state, to_state, actor) VALUES (gen_random_uuid(), 'V9', 'payment_pending', 'payment_confirmed', 'web')"],
    ["reserve without the KYC gate", `SELECT offering.reserve(gen_random_uuid(), gen_random_uuid(), '0x${"0".repeat(64)}', gen_random_uuid(), 10, 'retail', 'idem-12345678', 'web:x')`],
    ["cancel without the wrapper", "SELECT offering.cancel(gen_random_uuid(), gen_random_uuid(), 'web')"],
    ["accept without the wrapper", "SELECT offering.accept_document(gen_random_uuid(), gen_random_uuid(), 'risk_disclosure', 'en', 'x', 'x', 'x', 'web')"],
    ["withdraw", "SELECT offering.withdraw(gen_random_uuid(), gen_random_uuid(), 'web')"],
    ["run the clock", "SELECT offering.tick(gen_random_uuid(), 'web')"],
    ["sync a payment", "SELECT offering.sync_payment(gen_random_uuid(), 'web')"],
    ["start minting", "SELECT offering.start_minting(gen_random_uuid(), 'web')"],
    ["send a refund", "SELECT offering.execute_refund(gen_random_uuid(), 'web')"],
    ["decide a request", "SELECT offering.decide(1, 'web', true, 'web cannot decide')"],
    ["open a request", "SELECT offering.request(gen_random_uuid(), 'L8', 'web', 'web cannot request', '{}'::jsonb, NULL)"],
    ["block a subscription", "SELECT offering.block(gen_random_uuid(), 'web', 'web cannot block')"],
    ["ask for a duty", "SELECT offering.request_duty('web', 'offering', 'web', 'web cannot ask')"],
    ["run the dry run", "SELECT * FROM offering.dry_run(gen_random_uuid())"],
    ["count units", "SELECT * FROM offering.units(gen_random_uuid())"],
    ["call the internal helpers", "SELECT offering.web_state('blocked')"],
    ["call the actor check", "SELECT offering.web_check_actor('web:x')"],
    ["read KYC subjects", "SELECT * FROM kyc.subjects"],
    ["read a KYC status", "SELECT kyc.subject_status(gen_random_uuid())"],
    ["read payment intents", "SELECT * FROM bank.payment_intents"],
    ["read payees", "SELECT * FROM bank.payees"],
    ["read recon bank accounts", "SELECT * FROM recon.bank_accounts"],
    ["read properties", "SELECT * FROM property.properties"],
  ])("cannot %s", async (_label, sql) => {
    expect(await sqlstate(web.query(sql))).toBe("42501");
  });
});
