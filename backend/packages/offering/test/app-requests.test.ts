import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { refIdFor } from "../src/service.ts";
import { hex32, investor, liveOffering, makeWorld, type Investor, type Offering, type World } from "./world.ts";

/**
 * Migration 0060 (PR-1..PR-4): the app asks for a reservation with an Idempotency-Key; nothing is
 * reserved until the investor confirms on the website through webauth.web_reserve; the website binds
 * the new subscription to the request (same investor, offering and units) or declines it; the app
 * reads the subscription with its payment instructions.
 */
let w: World;
let o: Offering;
const sha = (s: string): Buffer => createHash("sha256").update(s, "utf8").digest();

beforeAll(async () => {
  w = await makeWorld();
  o = await liveOffering(w, { cap: 200n, maxUnits: 100n });
}, 180_000);

afterAll(async () => {
  await w.drop();
}, 120_000);

interface App {
  inv: Investor;
  investorId: string;
  session: Buffer;
  access: Buffer;
}

/** A verified investor with a website session and a live app access token (inserted for the test). */
async function app(): Promise<App> {
  const inv = await investor(w, o.d);
  const { rows } = await w.client.query<{ id: string }>(
    "INSERT INTO webdemo.investors (display_name, wallet_address, kyc_status, kyc_subject) VALUES ('App Tester', $1, 'verified', $2) RETURNING id",
    [inv.wallet, inv.subjectId],
  );
  const investorId = rows[0]?.id ?? "";
  const session = sha(randomBytes(32).toString("base64url"));
  await w.client.query("SELECT webauth.web_start_session($1, $2, 'signup')", [session, investorId]);
  const access = sha(randomBytes(32).toString("base64url"));
  await w.client.query(
    `INSERT INTO papi.tokens (family, investor_id, device_name, access_hash, refresh_hash, issued_at, access_expires_at, refresh_expires_at)
     SELECT gen_random_uuid(), $1, 'Pixel 9', $2, $3, t, t + interval '15 minutes', t + interval '30 days' FROM (SELECT date_trunc('microseconds', clock_timestamp()) AS t) x`,
    [investorId, access, sha(randomBytes(32).toString("base64url"))],
  );
  return { inv, investorId, session, access };
}

type Req = { id?: string; status?: string; code?: string; units?: string; amount_paisa?: string; subscription_id?: string | null; replayed?: boolean; error?: string };
const ask = async (a: App, units: number, key: string, code = "BCDFGHJK", offering = o.id): Promise<Req> =>
  (await w.client.query<{ r: Req }>("SELECT papi.request_reserve($1, $2, $3, $4, $5) AS r", [a.access, offering, units, key, code])).rows[0]?.r ?? {};

/** What the website does on /confirm: accept the documents, reserve through the session gate. */
async function websiteReserve(a: App, units: number): Promise<string> {
  for (const [kind, doc] of [
    ["offering_document", o.docs.en],
    ["risk_disclosure", o.docs.risk],
  ] as const) {
    await w.client.query("SELECT offering.web_accept_document($1, $2, $3, 'en', $4, $5, $6, $7)", [o.id, a.inv.subjectId, kind, doc, hex32(), hex32(), `web:${a.investorId}`]);
  }
  const sub = randomUUID();
  const { rows } = await w.client.query<{ r: { subscriptionId?: string; error?: string } }>("SELECT webauth.web_reserve($1, $2, $3, $4, $5, $6) AS r", [
    a.session,
    o.id,
    sub,
    refIdFor(sub),
    units,
    `web-${randomUUID()}`,
  ]);
  const r = rows[0]?.r;
  if (!r?.subscriptionId) throw new Error(`website reserve refused: ${JSON.stringify(r)}`);
  return r.subscriptionId;
}

describe("app requests confirmed on the website (migration 0060)", () => {
  it("a request reserves nothing; the same key replays it, another body conflicts; an unknown offering and a sixth pending request are refused", async () => {
    const a = await app();
    const first = await ask(a, 10, "key-aaaaaaa1", "BCDFGHJK");
    expect(first).toMatchObject({ status: "pending", units: "10", amount_paisa: (o.price * 10n).toString(), code: "BCDFGHJK", subscription_id: null, replayed: false });
    expect(await ask(a, 10, "key-aaaaaaa1", "ZZZZZZZZ")).toMatchObject({ id: first.id, replayed: true, code: "BCDFGHJK" });
    expect(await ask(a, 11, "key-aaaaaaa1")).toEqual({ error: "conflict" });
    expect(await ask(a, 10, "key-aaaaaaa2", "CDFGHJKL", randomUUID())).toEqual({ error: "offering" });
    // The code is free again only once the first request is no longer pending.
    expect(await ask(a, 10, "key-aaaaaaa3", "BCDFGHJK")).toEqual({ error: "code" });
    const subs = await w.client.query("SELECT 1 FROM offering.subscriptions WHERE subject_id = $1", [a.inv.subjectId]);
    expect(subs.rowCount).toBe(0);
    for (const [i, code] of ["CDFGHJKL", "DFGHJKLM", "FGHJKLMN", "GHJKLMNP"].entries()) expect(await ask(a, 1, `key-bbbbbbb${String(i)}`, code)).toMatchObject({ status: "pending" });
    expect(await ask(a, 1, "key-ccccccc1", "HJKLMNPQ")).toEqual({ error: "limit" });
    // Without a live token nothing happens.
    expect((await w.client.query<{ r: Req }>("SELECT papi.request_reserve($1, $2, 1, 'key-ddddddd1', 'JKLMNPQR') AS r", [sha("nope"), o.id])).rows[0]?.r).toEqual({ error: "token" });
  });

  it("the website binds only a matching subscription of the same investor; the app then reads the payment instructions", async () => {
    const a = await app();
    const other = await app();
    const r = await ask(a, 12, "key-eeeeeee1", "KLMNPQRS");
    // Looked up only by its owner's session.
    expect((await w.client.query<{ r: unknown }>("SELECT papi.web_request_lookup($1, 'KLMN-PQRS') AS r", [other.session])).rows[0]?.r).toBeNull();
    expect((await w.client.query<{ r: Req }>("SELECT papi.web_request_lookup($1, 'klmn-pqrs') AS r", [a.session])).rows[0]?.r).toMatchObject({ id: r.id, status: "pending" });

    const wrong = await websiteReserve(a, 15);
    expect((await w.client.query<{ r: unknown }>("SELECT papi.web_request_done($1, 'KLMNPQRS', $2) AS r", [a.session, wrong])).rows[0]?.r).toEqual({ error: "mismatch" });
    const theirs = await websiteReserve(other, 12);
    expect((await w.client.query<{ r: unknown }>("SELECT papi.web_request_done($1, 'KLMNPQRS', $2) AS r", [a.session, theirs])).rows[0]?.r).toEqual({ error: "mismatch" });
    // One open reservation per investor and offering (OF-17): the wrong one is cancelled first.
    await w.client.query("SELECT webauth.web_cancel($1, $2)", [a.session, wrong]);
    const sub = await websiteReserve(a, 12);
    expect((await w.client.query<{ r: unknown }>("SELECT papi.web_request_done($1, 'KLMNPQRS', $2) AS r", [a.session, sub])).rows[0]?.r).toEqual({ ok: true });
    expect((await w.client.query<{ r: unknown }>("SELECT papi.web_request_done($1, 'KLMNPQRS', $2) AS r", [a.session, sub])).rows[0]?.r).toEqual({ error: "code" });

    const seen = (await w.client.query<{ r: Req }>("SELECT papi.request($1, $2) AS r", [a.access, r.id])).rows[0]?.r;
    expect(seen).toMatchObject({ status: "confirmed", subscription_id: sub });
    expect((await w.client.query<{ r: unknown }>("SELECT papi.request($1, $2) AS r", [other.access, r.id])).rows[0]?.r).toBeNull();

    type Detail = { status: string; units: string; payment: { code: string; pay_to_account: string | null } | null };
    const d = (await w.client.query<{ r: Detail }>("SELECT papi.subscription($1, $2) AS r", [a.access, sub])).rows[0]?.r;
    expect(d).toMatchObject({ units: "12", payment: { code: expect.stringMatching(/^PT-/) as unknown } });
    expect((await w.client.query<{ r: unknown }>("SELECT papi.subscription($1, $2) AS r", [other.access, sub])).rows[0]?.r).toBeNull();

    // A decided request never changes again; declining works only on a pending one.
    const d2 = await ask(a, 3, "key-eeeeeee2", "LMNPQRST");
    expect((await w.client.query<{ r: unknown }>("SELECT papi.web_request_decline($1, 'LMNPQRST') AS r", [a.session])).rows[0]?.r).toEqual({ ok: true });
    expect((await w.client.query<{ r: Req }>("SELECT papi.request($1, $2) AS r", [a.access, d2.id])).rows[0]?.r).toMatchObject({ status: "declined" });
    await expect(w.client.query("UPDATE papi.requests SET status = 'pending', decided_at = NULL WHERE id = $1", [d2.id])).rejects.toMatchObject({ code: "23514" });
  });

  it("the service's login and the website's role can call only their own functions", async () => {
    const grants = await w.client.query<{ routine: string; grantee: string }>(
      `SELECT p.proname AS routine, r.rolname AS grantee FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       CROSS JOIN pg_roles r WHERE n.nspname = 'papi' AND r.rolname IN ('pt_svc_public_api', 'pt_web')
         AND p.proname IN ('request_reserve', 'request', 'subscription', 'web_request_lookup', 'web_request_done', 'web_request_decline')
         AND has_function_privilege(r.oid, p.oid, 'EXECUTE') ORDER BY 1, 2`,
    );
    expect(grants.rows.map((g) => `${g.routine}:${g.grantee}`)).toEqual([
      "request:pt_svc_public_api",
      "request_reserve:pt_svc_public_api",
      "subscription:pt_svc_public_api",
      "web_request_decline:pt_web",
      "web_request_done:pt_web",
      "web_request_lookup:pt_web",
    ]);
  });
});
