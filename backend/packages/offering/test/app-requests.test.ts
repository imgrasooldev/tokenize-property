import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newPushKeyPair, PushOpener, PushSealer } from "@pt/notify";
import { refIdFor } from "../src/service.ts";
import { hex32, investor, liveOffering, makeWorld, OF, pay, type Investor, type Offering, type World } from "./world.ts";

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
async function app(off: Offering = o): Promise<App> {
  const inv = await investor(w, off.d);
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
async function websiteReserve(a: App, units: number, off: Offering = o): Promise<string> {
  for (const [kind, doc] of [
    ["offering_document", off.docs.en],
    ["risk_disclosure", off.docs.risk],
  ] as const) {
    await w.client.query("SELECT offering.web_accept_document($1, $2, $3, 'en', $4, $5, $6, $7)", [off.id, a.inv.subjectId, kind, doc, hex32(), hex32(), `web:${a.investorId}`]);
  }
  const sub = randomUUID();
  const { rows } = await w.client.query<{ r: { subscriptionId?: string; error?: string } }>("SELECT webauth.web_reserve($1, $2, $3, $4, $5, $6) AS r", [
    a.session,
    off.id,
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

  it("migration 0061: cancel from the app is confirmed only after the website really cancelled; another investor's subscription is unknown", async () => {
    const a = await app();
    const other = await app();
    const sub = await websiteReserve(a, 14);
    const change = async (x: App, target: string, kind: string, key: string, code: string): Promise<Req> =>
      (await w.client.query<{ r: Req }>("SELECT papi.request_change($1, $2, $3, $4, $5) AS r", [x.access, target, kind, key, code])).rows[0]?.r ?? {};
    expect(await change(other, sub, "cancel", "key-fffffff1", "MNPQRSTV")).toEqual({ error: "unknown" });
    expect(await change(a, sub, "withdraw", "key-fffffff2", "MNPQRSTV")).toEqual({ error: "state" });
    expect(await change(a, sub, "sell", "key-fffffff3", "MNPQRSTV")).toEqual({ error: "input" });
    const r = await change(a, sub, "cancel", "key-fffffff4", "MNPQRSTV");
    expect(r).toMatchObject({ kind: "cancel", status: "pending", units: "14", subscription_id: sub, replayed: false });
    expect(await change(a, sub, "cancel", "key-fffffff4", "NPQRSTVW")).toMatchObject({ id: r.id, replayed: true });
    expect(await change(a, randomUUID(), "cancel", "key-fffffff4", "NPQRSTVW")).toEqual({ error: "conflict" });
    // Nothing changed yet: finishing is refused while the subscription is still reserved.
    expect((await w.client.query<{ r: unknown }>("SELECT papi.web_request_finish($1, 'MNPQRSTV') AS r", [a.session])).rows[0]?.r).toEqual({ error: "mismatch" });
    expect((await w.client.query<{ r: unknown }>("SELECT papi.web_request_finish($1, 'MNPQRSTV') AS r", [other.session])).rows[0]?.r).toEqual({ error: "code" });
    // A reserve request is never finished this way.
    await ask(a, 1, "key-fffffff5", "PQRSTVWX");
    expect((await w.client.query<{ r: unknown }>("SELECT papi.web_request_finish($1, 'PQRSTVWX') AS r", [a.session])).rows[0]?.r).toEqual({ error: "code" });
    await w.client.query("SELECT webauth.web_cancel($1, $2)", [a.session, sub]);
    expect((await w.client.query<{ r: unknown }>("SELECT papi.web_request_finish($1, 'MNPQRSTV') AS r", [a.session])).rows[0]?.r).toEqual({ ok: true });
    expect((await w.client.query<{ r: Req }>("SELECT papi.request($1, $2) AS r", [a.access, r.id])).rows[0]?.r).toMatchObject({ status: "confirmed", subscription_id: sub });
    // A cancelled subscription cannot be cancelled again; the table keeps target and kind consistent.
    expect(await change(a, sub, "cancel", "key-fffffff6", "QRSTVWXZ")).toEqual({ error: "state" });
    await expect(
      w.client.query("INSERT INTO papi.requests (investor_id, kind, offering_id, units, idempotency_key, code, created_at, expires_at) SELECT investor_id, 'cancel', offering_id, units, 'key-fffffff7', 'RSTVWXZB', created_at, expires_at FROM papi.requests WHERE id = $1", [r.id]),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("migration 0061: withdraw from the app needs a paid subscription and an open withdrawal window; confirmed only after the website withdrew", async () => {
    const o2 = await liveOffering(w, { cap: 100n, maxUnits: 50n });
    const a = await app(o2);
    const sub = await websiteReserve(a, 15, o2);
    const s = (await w.client.query<{ code: string; amount: string }>("SELECT payment_code AS code, amount_paisa::text AS amount FROM offering.web_subscriptions($1) WHERE subscription_id = $2", [a.inv.subjectId, sub])).rows[0];
    await pay(w, a.inv, s?.code ?? null, BigInt(s?.amount ?? "0"));
    const change = async (key: string, code: string): Promise<Req> =>
      (await w.client.query<{ r: Req }>("SELECT papi.request_change($1, $2, 'withdraw', $3, $4) AS r", [a.access, sub, key, code])).rows[0]?.r ?? {};
    // Paid, but no withdrawal right is open.
    expect(await change("key-ggggggg1", "STVWXZBC")).toEqual({ error: "state" });
    const ext = await w.of("request", { offeringId: o2.id, code: "L10", actor: OF.maker, reason: "slow uptake, extend by 20 days", detail: { days: 20, disclosureSha: hex32() } });
    await w.of("decide", { requestId: ext, officer: OF.checker, approve: true, reason: "extension reason accepted" });
    await w.of("decide", { requestId: ext, officer: OF.trustee, approve: true, reason: "trustee agrees to extend" });
    const r = await change("key-ggggggg2", "STVWXZBC");
    expect(r).toMatchObject({ kind: "withdraw", status: "pending", subscription_id: sub });
    expect((await w.client.query<{ r: unknown }>("SELECT papi.web_request_finish($1, 'STVWXZBC') AS r", [a.session])).rows[0]?.r).toEqual({ error: "mismatch" });
    const v = (await w.client.query<{ r: { state?: string } }>("SELECT webauth.web_withdraw($1, $2) AS r", [a.session, sub])).rows[0]?.r;
    expect(v?.state).toBe("refund_pending");
    expect((await w.client.query<{ r: unknown }>("SELECT papi.web_request_finish($1, 'STVWXZBC') AS r", [a.session])).rows[0]?.r).toEqual({ ok: true });
    expect((await w.client.query<{ r: Req }>("SELECT papi.request($1, $2) AS r", [a.access, r.id])).rows[0]?.r).toMatchObject({ status: "confirmed", subscription_id: sub });
  }, 120_000);

  it("migration 0062: an order request places nothing; the website binds only the same order of the same investor; the book and own orders read", async () => {
    const a = await app();
    const other = await app();
    const order = async (x: App, side: string, price: number, tokens: number, key: string, code: string, symbol = "GPF3"): Promise<Req & { order_id?: string | null; total_paisa?: string; kind?: string }> =>
      (await w.client.query<{ r: Req }>("SELECT papi.request_order($1, $2, $3, $4, $5, $6, $7) AS r", [x.access, symbol, side, price, tokens, key, code])).rows[0]?.r ?? {};
    expect(await order(a, "hold", 50000, 2, "key-hhhhhhh1", "VWXZBCDF")).toEqual({ error: "input" });
    expect(await order(a, "buy", 50000, 2, "key-hhhhhhh1", "VWXZBCDF", "gpf3")).toEqual({ error: "input" });
    const r = await order(a, "buy", 50000, 2, "key-hhhhhhh2", "VWXZBCDF");
    expect(r).toMatchObject({ kind: "order", status: "pending", total_paisa: "100000", order_id: null, replayed: false });
    expect(await order(a, "buy", 50000, 2, "key-hhhhhhh2", "WXZBCDFG")).toMatchObject({ id: r.id, replayed: true });
    expect(await order(a, "buy", 50100, 2, "key-hhhhhhh2", "WXZBCDFG")).toEqual({ error: "conflict" });
    // A reserve request with the same key is a conflict too; the order request is not a subscription request.
    expect(await ask(a, 10, "key-hhhhhhh2")).toEqual({ error: "conflict" });
    expect((await w.client.query<{ r: unknown }>("SELECT papi.request($1, $2) AS r", [a.access, r.id])).rows[0]?.r).toBeNull();
    expect((await w.client.query<{ r: unknown }>("SELECT papi.order_request($1, $2) AS r", [other.access, r.id])).rows[0]?.r).toBeNull();
    expect((await w.client.query<{ r: { kind?: string } }>("SELECT papi.web_request_lookup($1, 'VWXZ-BCDF') AS r", [a.session])).rows[0]?.r).toMatchObject({ kind: "order", symbol: "GPF3", side: "buy" });

    const place = async (x: App, side: string, price: number, tokens: number): Promise<string> => {
      const id = randomUUID();
      await w.client.query("INSERT INTO webdemo.orders (id, request_id, investor_id, symbol, side, price_paisa, tokens, status) VALUES ($1, $2, $3, 'GPF3', $4, $5, $6, 'open')", [id, randomUUID(), x.investorId, side, price, tokens]);
      return id;
    };
    const done = async (x: App, code: string, id: string): Promise<unknown> => (await w.client.query<{ r: unknown }>("SELECT papi.web_request_order_done($1, $2, $3) AS r", [x.session, code, id])).rows[0]?.r;
    expect(await done(a, "VWXZBCDF", await place(a, "buy", 50000, 3))).toEqual({ error: "mismatch" });
    expect(await done(a, "VWXZBCDF", await place(other, "buy", 50000, 2))).toEqual({ error: "mismatch" });
    expect(await done(other, "VWXZBCDF", await place(other, "buy", 50000, 2))).toEqual({ error: "code" });
    const mine = await place(a, "buy", 50000, 2);
    expect(await done(a, "VWXZBCDF", mine)).toEqual({ ok: true });
    expect((await w.client.query<{ r: unknown }>("SELECT papi.order_request($1, $2) AS r", [a.access, r.id])).rows[0]?.r).toMatchObject({ status: "confirmed", order_id: mine });

    await place(other, "sell", 52000, 4);
    await place(other, "sell", 52000, 1);
    const book = (await w.client.query<{ book: { bids: { price_paisa: string; tokens: string }[]; asks: { price_paisa: string; tokens: string }[] } }>("SELECT book FROM papi.markets('GPF3')")).rows[0]?.book;
    expect(book?.asks[0]).toEqual({ price_paisa: "52000", tokens: "5" });
    expect(book?.bids[0]?.price_paisa).toBe("50000");
    const own = await w.client.query<{ id: string }>("SELECT id FROM papi.orders($1)", [a.access]);
    expect(own.rows.map((o) => o.id)).toContain(mine);
    expect(own.rows).toHaveLength(2);
    expect((await w.client.query("SELECT id FROM papi.orders($1)", [sha("nope")])).rowCount).toBe(0);
  });

  it("migration 0063: cancelling an open order needs the website; only the investor's own open order, bound only once really cancelled", async () => {
    const a = await app();
    const other = await app();
    const place = async (x: App, status = "open", filled = 0): Promise<string> => {
      const id = randomUUID();
      await w.client.query("INSERT INTO webdemo.orders (id, request_id, investor_id, symbol, side, price_paisa, tokens, filled, status) VALUES ($1, $2, $3, 'GPF3', 'sell', 51000, 4, $4, $5)", [
        id,
        randomUUID(),
        x.investorId,
        filled,
        status,
      ]);
      return id;
    };
    type OReq = Req & { kind?: string; order_id?: string | null; target_order_id?: string | null; side?: string; tokens?: string };
    const cancel = async (x: App, order: string, key: string, code: string): Promise<OReq> =>
      (await w.client.query<{ r: OReq }>("SELECT papi.request_order_cancel($1, $2, $3, $4) AS r", [x.access, order, key, code])).rows[0]?.r ?? {};
    const open = await place(a);
    // Not the investor's, not open, fully filled, unknown: refused alike.
    expect(await cancel(a, await place(other), "key-iiiiiii1", "XZBCDFGH")).toEqual({ error: "order" });
    expect(await cancel(a, await place(a, "cancelled"), "key-iiiiiii1", "XZBCDFGH")).toEqual({ error: "order" });
    expect(await cancel(a, await place(a, "open", 4), "key-iiiiiii1", "XZBCDFGH")).toEqual({ error: "order" });
    expect(await cancel(a, randomUUID(), "key-iiiiiii1", "XZBCDFGH")).toEqual({ error: "order" });
    const r = await cancel(a, open, "key-iiiiiii2", "ZBCDFGHJ");
    expect(r).toMatchObject({ kind: "order_cancel", status: "pending", side: "sell", tokens: "4", order_id: null, target_order_id: open, replayed: false });
    expect(await cancel(a, open, "key-iiiiiii2", "BCDFGHKL")).toMatchObject({ id: r.id, replayed: true });
    expect(await cancel(a, await place(a), "key-iiiiiii2", "BCDFGHKL")).toEqual({ error: "conflict" });
    // The request itself changes nothing; it is an order request, never a subscription request.
    expect((await w.client.query<{ status: string }>("SELECT status FROM webdemo.orders WHERE id = $1", [open])).rows[0]?.status).toBe("open");
    expect((await w.client.query<{ r: unknown }>("SELECT papi.request($1, $2) AS r", [a.access, r.id])).rows[0]?.r).toBeNull();
    expect((await w.client.query<{ r: unknown }>("SELECT papi.order_request($1, $2) AS r", [a.access, r.id])).rows[0]?.r).toMatchObject({ kind: "order_cancel", target_order_id: open });
    expect((await w.client.query<{ r: { kind?: string } }>("SELECT papi.web_request_lookup($1, 'ZBCD-FGHJ') AS r", [a.session])).rows[0]?.r).toMatchObject({ kind: "order_cancel" });

    const finish = async (x: App): Promise<unknown> => (await w.client.query<{ r: unknown }>("SELECT papi.web_request_order_cancel_done($1, 'ZBCDFGHJ') AS r", [x.session])).rows[0]?.r;
    expect(await finish(a)).toEqual({ error: "mismatch" });
    expect(await finish(other)).toEqual({ error: "code" });
    await w.client.query("UPDATE webdemo.orders SET status = 'cancelled', note = 'cancelled by investor' WHERE id = $1", [open]);
    expect(await finish(a)).toEqual({ ok: true });
    expect(await finish(a)).toEqual({ error: "code" });
    expect((await w.client.query<{ r: unknown }>("SELECT papi.order_request($1, $2) AS r", [a.access, r.id])).rows[0]?.r).toMatchObject({ status: "confirmed", order_id: open });
  });

  it("migration 0064: a top-up request adds no cash; the website's demo top-up is bound only for the same investor and amount; cash reads from the ledger", async () => {
    const a = await app();
    const other = await app();
    type TReq = Req & { kind?: string; topup_id?: string | null };
    const topup = async (x: App, amount: number, key: string, code: string): Promise<TReq> =>
      (await w.client.query<{ r: TReq }>("SELECT papi.request_topup($1, $2, $3, $4) AS r", [x.access, amount, key, code])).rows[0]?.r ?? {};
    const cash = async (x: App): Promise<unknown> => (await w.client.query<{ r: unknown }>("SELECT papi.cash($1) AS r", [x.access])).rows[0]?.r;
    expect(await cash(a)).toEqual({ available_paisa: "0", in_orders_paisa: "0" });
    expect(await topup(a, 150, "key-jjjjjjj1", "BCDFGHJM")).toEqual({ error: "input" }); // whole rupees only
    expect(await topup(a, 0, "key-jjjjjjj1", "BCDFGHJM")).toEqual({ error: "input" });
    expect(await topup(a, 2_000_000_000, "key-jjjjjjj1", "BCDFGHJM")).toEqual({ error: "input" });
    const r = await topup(a, 500_000, "key-jjjjjjj2", "BCDFGHJN");
    expect(r).toMatchObject({ kind: "topup", status: "pending", amount_paisa: "500000", topup_id: null, replayed: false });
    expect(await topup(a, 500_000, "key-jjjjjjj2", "BCDFGHJP")).toMatchObject({ id: r.id, replayed: true });
    expect(await topup(a, 600_000, "key-jjjjjjj2", "BCDFGHJP")).toEqual({ error: "conflict" });
    expect((await w.client.query<{ r: unknown }>("SELECT papi.request($1, $2) AS r", [a.access, r.id])).rows[0]?.r).toBeNull();
    expect((await w.client.query<{ r: unknown }>("SELECT papi.order_request($1, $2) AS r", [a.access, r.id])).rows[0]?.r).toBeNull();
    expect((await w.client.query<{ r: unknown }>("SELECT papi.topup_request($1, $2) AS r", [other.access, r.id])).rows[0]?.r).toBeNull();
    expect((await w.client.query<{ r: { kind?: string } }>("SELECT papi.web_request_lookup($1, 'BCDF-GHJN') AS r", [a.session])).rows[0]?.r).toMatchObject({ kind: "topup", amount_paisa: "500000" });
    expect(await cash(a)).toEqual({ available_paisa: "0", in_orders_paisa: "0" });

    // What the website's demo top-up does: one webdemo.topups row (request id = the app request) and one journal.
    const demoTopUp = async (x: App, requestId: string, amount: number): Promise<void> => {
      const id = randomUUID();
      await w.client.query("INSERT INTO webdemo.topups (id, request_id, investor_id, amount_paisa, bank_ref) VALUES ($1, $2, $3, $4, 'RAAST-DEMO-0123456789AB')", [id, requestId, x.investorId, amount]);
      await w.client.query("SELECT ledger.open_account('web:bank:client-money', 'asset', 'PKR', false)");
      await w.client.query("SELECT ledger.open_account($1, 'liability', 'PKR', false)", [`web:investor:${x.investorId}:cash`]);
      await w.client.query("SELECT ledger.post_journal($1, 'cash_topup', 'Raast top-up (demo)', NULL, 'web-market', $2::jsonb)", [
        `web:topup:${id}`,
        JSON.stringify([
          { account: "web:bank:client-money", amount: String(amount) },
          { account: `web:investor:${x.investorId}:cash`, amount: String(-amount) },
        ]),
      ]);
    };
    const finish = async (x: App): Promise<unknown> => (await w.client.query<{ r: unknown }>("SELECT papi.web_request_topup_done($1, 'BCDFGHJN') AS r", [x.session])).rows[0]?.r;
    expect(await finish(a)).toEqual({ error: "mismatch" });
    await demoTopUp(other, r.id ?? "", 500_000); // the other investor's top-up never binds
    expect(await finish(a)).toEqual({ error: "mismatch" });
    expect(await finish(other)).toEqual({ error: "code" });
    const a2 = await topup(a, 300_000, "key-jjjjjjj3", "BCDFGHJQ");
    await demoTopUp(a, a2.id ?? "", 200_000); // another amount never binds either
    expect((await w.client.query<{ r: unknown }>("SELECT papi.web_request_topup_done($1, 'BCDFGHJQ') AS r", [a.session])).rows[0]?.r).toEqual({ error: "mismatch" });

    const b = await topup(a, 400_000, "key-jjjjjjj4", "BCDFGHJR");
    await demoTopUp(a, b.id ?? "", 400_000);
    expect((await w.client.query<{ r: unknown }>("SELECT papi.web_request_topup_done($1, 'BCDFGHJR') AS r", [a.session])).rows[0]?.r).toEqual({ ok: true });
    expect((await w.client.query<{ r: TReq }>("SELECT papi.topup_request($1, $2) AS r", [a.access, b.id])).rows[0]?.r).toMatchObject({ status: "confirmed", topup_id: expect.any(String) as unknown });
    expect(await cash(a)).toEqual({ available_paisa: "600000", in_orders_paisa: "0" });
    expect((await w.client.query("SELECT papi.cash($1) AS r", [sha("nope")])).rows[0]).toEqual({ r: null });
  });

  it("push devices (migration 0065): sealed for the worker only, one per device, moved, removed and ended by sign-out", async () => {
    const keys = newPushKeyPair();
    const sealer = PushSealer.fromEnv({ NOTIFY_PUSH_PUBLIC_KEY: keys.publicKey });
    const opener = PushOpener.fromEnv({ NOTIFY_PUSH_PRIVATE_KEY: keys.privateKey });
    const a = await app();
    const other = await app();
    const recipient = async (x: App): Promise<string> =>
      (await w.client.query<{ r: string }>("SELECT papi.push_recipient($1, 'ur')::text AS r", [x.access])).rows[0]?.r ?? "";
    const register = async (x: App, rcpt: string, token: string, platform = "android"): Promise<string> => {
      const { lookupHash, sealed } = sealer.seal(rcpt, token);
      return (await w.client.query<{ r: string }>("SELECT papi.register_push($1, $2, $3, $4, $5) AS r", [x.access, rcpt, platform, lookupHash, sealed])).rows[0]?.r ?? "";
    };
    const current = async (x: App): Promise<{ id: string; lookup_hash: Buffer; sealed: Buffer; recipient_id: string }[]> =>
      (
        await w.client.query<{ id: string; lookup_hash: Buffer; sealed: Buffer; recipient_id: string }>(
          `SELECT c.id::text, c.lookup_hash, c.sealed, c.recipient_id::text FROM notify.contacts c JOIN papi.push_devices d ON d.contact_id = c.id
           WHERE d.investor_id = $1 AND c.superseded_at IS NULL AND d.removed_at IS NULL`,
          [x.investorId],
        )
      ).rows;
    const tokenA = `fcm-token-a:${"A".repeat(140)}`;
    const tokenB = `fcm-token-b:${"B".repeat(140)}`;

    const ra = await recipient(a);
    expect(ra).toMatch(/^[0-9a-f-]{36}$/);
    expect((await w.client.query("SELECT papi.push_recipient($1, 'en') AS r", [sha("nope")])).rows[0]).toEqual({ r: null });
    expect(await register(a, await recipient(other), tokenA)).toBe("recipient");
    expect(await register(a, ra, tokenA, "windows")).toBe("input");
    expect(await register(a, ra, tokenA)).toBe("ok");
    expect(await register(a, ra, tokenA)).toBe("ok"); // the same token again changes nothing
    let rows = await current(a);
    expect(rows).toHaveLength(1);
    // The database holds no readable token; only the worker's key opens it, and only for this recipient.
    expect(rows[0]?.sealed.toString("latin1")).not.toContain("fcm-token");
    expect(opener.open(ra, rows[0]?.lookup_hash ?? Buffer.alloc(0), rows[0]?.sealed ?? Buffer.alloc(0))).toBe(tokenA);
    expect(() => opener.open(randomUUID(), rows[0]?.lookup_hash ?? Buffer.alloc(0), rows[0]?.sealed ?? Buffer.alloc(0))).toThrow(/cannot be opened/);

    // A new token for the device replaces the old one.
    expect(await register(a, ra, tokenB)).toBe("ok");
    rows = await current(a);
    expect(rows).toHaveLength(1);
    expect(opener.open(ra, rows[0]?.lookup_hash ?? Buffer.alloc(0), rows[0]?.sealed ?? Buffer.alloc(0))).toBe(tokenB);

    // A notice fans out to the push contact with the push template (same text as the SMS).
    const subject = a.inv.subjectId;
    await w.client.query("SELECT notify.enqueue($1, 'security.account_frozen', 'investor', $2, $3::jsonb, 'test')", [
      `push-test:${randomUUID()}`,
      subject,
      JSON.stringify({ at: "2026-11-06T09:00:00Z" }),
    ]);
    const push = await w.client.query<{ channel: string; contact_id: string }>(
      "SELECT d.channel, d.contact_id::text FROM notify.deliveries d JOIN notify.notifications n ON n.id = d.notification_id WHERE n.recipient_id = $1 AND d.channel = 'push'",
      [ra],
    );
    expect(push.rows).toEqual([{ channel: "push", contact_id: rows[0]?.id }]);

    // The same phone signed in to another account: the token moves there.
    const ro = await recipient(other);
    expect(await register(other, ro, tokenB)).toBe("ok");
    expect(await current(a)).toHaveLength(0);
    expect(await current(other)).toHaveLength(1);

    // Removing the device, then signing out, end the push contact.
    expect((await w.client.query("SELECT papi.unregister_push($1) AS r", [other.access])).rows[0]).toEqual({ r: true });
    expect(await current(other)).toHaveLength(0);
    expect(await register(a, ra, tokenA)).toBe("ok");
    await w.client.query("SELECT papi.revoke($1)", [a.access]);
    expect(await current(a)).toHaveLength(0);
    expect(await register(a, ra, tokenA)).toBe("token");
    expect((await w.client.query("SELECT papi.unregister_push($1) AS r", [a.access])).rows[0]).toEqual({ r: false });
    const why = await w.client.query<{ removed_why: string }>("SELECT removed_why FROM papi.push_devices WHERE investor_id IN ($1, $2) ORDER BY id", [a.investorId, other.investorId]);
    expect(why.rows.map((r) => r.removed_why)).toEqual(["replaced", "moved", "unregistered", "signed_out"]);
  });

  it("the service's login and the website's role can call only their own functions", async () => {
    const grants = await w.client.query<{ routine: string; grantee: string }>(
      `SELECT p.proname AS routine, r.rolname AS grantee FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       CROSS JOIN pg_roles r WHERE n.nspname = 'papi' AND r.rolname IN ('pt_svc_public_api', 'pt_web')
         AND p.proname IN ('request_reserve', 'request_change', 'request_order', 'request', 'order_request', 'markets', 'orders', 'subscription', 'web_request_lookup', 'web_request_done', 'web_request_decline', 'web_request_finish', 'web_request_order_done', 'request_order_cancel', 'web_request_order_cancel_done', 'cash', 'request_topup', 'topup_request', 'web_request_topup_done', 'push_recipient', 'register_push', 'unregister_push', 'push_end')
         AND has_function_privilege(r.oid, p.oid, 'EXECUTE') ORDER BY 1, 2`,
    );
    expect(grants.rows.map((g) => `${g.routine}:${g.grantee}`)).toEqual([
      "cash:pt_svc_public_api",
      "markets:pt_svc_public_api",
      "order_request:pt_svc_public_api",
      "orders:pt_svc_public_api",
      "push_recipient:pt_svc_public_api",
      "register_push:pt_svc_public_api",
      "request:pt_svc_public_api",
      "request_change:pt_svc_public_api",
      "request_order:pt_svc_public_api",
      "request_order_cancel:pt_svc_public_api",
      "request_reserve:pt_svc_public_api",
      "request_topup:pt_svc_public_api",
      "subscription:pt_svc_public_api",
      "topup_request:pt_svc_public_api",
      "unregister_push:pt_svc_public_api",
      "web_request_decline:pt_web",
      "web_request_done:pt_web",
      "web_request_finish:pt_web",
      "web_request_lookup:pt_web",
      "web_request_order_cancel_done:pt_web",
      "web_request_order_done:pt_web",
      "web_request_topup_done:pt_web",
    ]);
  });
});
