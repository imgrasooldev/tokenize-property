import { createHash, randomBytes } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../../db/src/migrate.ts";
import { contiguousMigrations, scratchDatabase, serviceLogin } from "../../db/test/helpers.ts";
import { buildTree, processProof, rentLeaf } from "@pt/tax";
import { keccak256, stringToBytes, type Address } from "viem";
import { createApiServer } from "../src/http.ts";
import { pgRepositories } from "../src/repositories.ts";
import { newPushKeyPair, PushOpener, PushSealer } from "@pt/notify";
import { AuthService, CatalogueService, InvestorService, PushService } from "../src/services.ts";
import { OPENAPI, responseSchema, validate } from "./contract.ts";

/**
 * ADR 0018 / migration 0058 end to end on a scratch database, through HTTP, as the service's own
 * login: the Device Authorization Grant (pending, slow_down, approval on the website, tokens),
 * every read operation, refresh rotation with reuse detection, revocation, problems, ETag and rate
 * limits. Every response is validated against docs/api/openapi.json.
 */
let admin: pg.Client;
let pool: pg.Pool;
let login: Awaited<ReturnType<typeof serviceLogin>>;
let drop: () => Promise<void>;
let server: Server;
let base: string;
const sha = (s: string): Buffer => createHash("sha256").update(s, "utf8").digest();
const pushKeys = newPushKeyPair();

beforeAll(async () => {
  const s = await scratchDatabase();
  ({ client: admin, drop } = s);
  await migrate(admin, contiguousMigrations());
  login = await serviceLogin("public_api", String(s.settings.database));
  pool = new pg.Pool({ ...login.settings, max: 4 });
  const repos = pgRepositories(pool);
  server = createApiServer({
    auth: new AuthService(repos.grants, "http://localhost:3100/device"),
    catalogue: new CatalogueService(repos.catalogue),
    investors: new InvestorService(repos.investors),
    push: new PushService(repos.push, PushSealer.fromEnv({ NOTIFY_PUSH_PUBLIC_KEY: pushKeys.publicKey })),
    openapi: OPENAPI,
    ratePerMinute: 200,
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
}, 180_000);

afterAll(async () => {
  server.close();
  await pool.end();
  await drop();
  await login.drop();
}, 180_000);

/** Calls the API and checks the answer against the contract operation (path template). */
async function call(template: string, path: string, init: RequestInit = {}): Promise<{ status: number; body: unknown; headers: Headers }> {
  const res = await fetch(`${base}/v1${path}`, init);
  const text = await res.text();
  const body: unknown = text ? JSON.parse(text) : undefined;
  if (res.status !== 304) {
    const spec = responseSchema(template, init.method ?? "GET", res.status);
    if (spec) {
      expect(res.headers.get("content-type")).toContain(spec.media);
      expect(validate(spec.schema, body), `${template} ${String(res.status)}`).toEqual([]);
    }
  }
  expect(res.headers.get("x-request-id")).toBeTruthy();
  return { status: res.status, body, headers: res.headers };
}

const formPost = (fields: Record<string, string>): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(fields).toString(),
});

/** A verified investor with a website session (as the website signs one up). */
async function investor(): Promise<{ id: string; session: Buffer }> {
  const k = await admin.query<{ id: string }>("SELECT kyc.register_subject($1::bytea[], '{1}'::smallint[], $2, $3, '2468', 'kyc-service') AS id", [[randomBytes(32)], randomBytes(32), randomBytes(60)]);
  await admin.query("INSERT INTO kyc.decisions (subject_id, status, reason, basis, valid_until, decided_by) VALUES ($1, 'verified', 'test decision', '{}', now() + interval '1 year', 'kyc-service')", [k.rows[0]?.id]);
  const { rows } = await admin.query<{ id: string }>(
    "INSERT INTO webdemo.investors (display_name, wallet_address, kyc_status, kyc_subject) VALUES ('App Tester', $1, 'verified', $2) RETURNING id",
    [`0x${randomBytes(20).toString("hex")}`, k.rows[0]?.id],
  );
  const t = randomBytes(32).toString("base64url");
  await admin.query("SELECT webauth.web_start_session($1, $2, 'signup')", [sha(t), rows[0]?.id]);
  return { id: rows[0]?.id ?? "", session: sha(t) };
}

type Tokens = { access_token: string; refresh_token: string };

async function signIn(who: { session: Buffer }): Promise<Tokens> {
  const d = await call("/oauth/device_authorization", "/oauth/device_authorization", formPost({ client_id: "pt-mobile", scope: "read", device_name: "Pixel 9" }));
  expect(d.status).toBe(200);
  const auth = d.body as { device_code: string; user_code: string };
  const decided = await admin.query<{ r: { ok?: boolean } }>("SELECT papi.web_device_decide($1, $2, 'approve') AS r", [who.session, auth.user_code]);
  expect(decided.rows[0]?.r.ok).toBe(true);
  const t = await call("/oauth/token", "/oauth/token", formPost({ grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: auth.device_code, client_id: "pt-mobile" }));
  expect(t.status).toBe(200);
  return t.body as Tokens;
}

const bearer = (t: string): RequestInit => ({ headers: { authorization: `Bearer ${t}` } });

describe("public API v1 (ADR 0018)", () => {
  it("device grant: pending, slow_down, then tokens after the investor approves on the website; a code is used once", async () => {
    const who = await investor();
    const d = await call("/oauth/device_authorization", "/oauth/device_authorization", formPost({ client_id: "pt-mobile" }));
    const auth = d.body as { device_code: string; user_code: string; verification_uri_complete: string; interval: number };
    expect(auth.user_code).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
    expect(auth.verification_uri_complete).toBe(`http://localhost:3100/device?code=${auth.user_code}`);
    const poll = () => call("/oauth/token", "/oauth/token", formPost({ grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: auth.device_code, client_id: "pt-mobile" }));
    expect((await poll()).body).toEqual({ error: "authorization_pending" });
    expect((await poll()).body).toEqual({ error: "slow_down" });
    expect((await admin.query<{ r: unknown }>("SELECT papi.web_device_lookup($1, $2) AS r", [who.session, auth.user_code])).rows[0]?.r).toMatchObject({ deviceName: "Mobile device" });
    await admin.query("SELECT papi.web_device_decide($1, $2, 'approve')", [who.session, auth.user_code]);
    const ok = await poll();
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toBe("no-store");
    expect((await poll()).body).toEqual({ error: "invalid_grant" });
    // Wrong client and unknown grant types follow RFC 6749.
    expect((await call("/oauth/token", "/oauth/token", formPost({ grant_type: "password", client_id: "pt-mobile" }))).body).toEqual({ error: "unsupported_grant_type" });
    expect((await call("/oauth/device_authorization", "/oauth/device_authorization", formPost({ client_id: "other" }))).body).toEqual({ error: "invalid_client" });
  });

  it("a denied code gives access_denied", async () => {
    const who = await investor();
    const d = (await call("/oauth/device_authorization", "/oauth/device_authorization", formPost({ client_id: "pt-mobile" }))).body as { device_code: string; user_code: string };
    await admin.query("SELECT papi.web_device_decide($1, $2, 'deny')", [who.session, d.user_code]);
    const t = await call("/oauth/token", "/oauth/token", formPost({ grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: d.device_code, client_id: "pt-mobile" }));
    expect(t.body).toEqual({ error: "access_denied" });
  });

  it("every read follows the contract; investor data needs a live token; ETag gives 304", async () => {
    const who = await investor();
    const t = await signIn(who);
    const me = await call("/me", "/me", bearer(t.access_token));
    expect(me.body).toMatchObject({ id: who.id, kyc: "verified", residency: { status: "resident", document: "cnic", country: null } });
    expect(me.headers.get("cache-control")).toBe("private, no-store");
    const etag = me.headers.get("etag") ?? "";
    expect((await call("/me", "/me", { headers: { authorization: `Bearer ${t.access_token}`, "if-none-match": etag } })).status).toBe(304);
    expect((await call("/me/holdings", "/me/holdings", bearer(t.access_token))).body).toMatchObject({ data: [] });
    expect((await call("/me/subscriptions", "/me/subscriptions?limit=5", bearer(t.access_token))).body).toEqual({ data: [], next_cursor: null });
    expect((await call("/me/tax-certificates", "/me/tax-certificates", bearer(t.access_token))).body).toEqual({ data: [] });
    // The KYC decision raised a notification (0030 producers); the API renders it like the e-mail, in the requested language.
    const inbox = (await call("/me/notifications", "/me/notifications", bearer(t.access_token))).body as { data: { event: string; title: string }[] };
    expect(inbox.data[0]).toMatchObject({ event: "security.kyc_status_changed", title: "Your verification status changed" });
    const ur = (await call("/me/notifications", "/me/notifications", { headers: { authorization: `Bearer ${t.access_token}`, "accept-language": "ur" } })).body as { data: { title: string }[] };
    expect(ur.data[0]?.title).not.toBe(inbox.data[0]?.title);
    expect((await call("/offerings", "/offerings")).status).toBe(200);
    expect((await call("/status", "/status")).status).toBe(200);
    expect((await call("/offerings/{offeringId}", "/offerings/00000000-0000-4000-8000-000000000000")).status).toBe(404);
    const anonymous = await call("/me", "/me");
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get("www-authenticate")).toContain("invalid_token");
    expect((await call("/me/subscriptions", "/me/subscriptions?limit=500", bearer(t.access_token))).status).toBe(400);
    const spec = await fetch(`${base}/v1/openapi.json`);
    expect(((await spec.json()) as { openapi: string }).openapi).toBe("3.1.0");
  });

  it("refresh tokens rotate; a reused refresh token revokes the device; revocation signs out", async () => {
    const who = await investor();
    const first = await signIn(who);
    const refresh = (rt: string) => call("/oauth/token", "/oauth/token", formPost({ grant_type: "refresh_token", refresh_token: rt, client_id: "pt-mobile" }));
    const second = (await refresh(first.refresh_token)).body as Tokens;
    expect(second.access_token).not.toBe(first.access_token);
    expect((await call("/me", "/me", bearer(second.access_token))).status).toBe(200);
    // The first refresh token is spent: presenting it again revokes the whole family.
    expect((await refresh(first.refresh_token)).body).toEqual({ error: "invalid_grant" });
    expect((await call("/me", "/me", bearer(second.access_token))).status).toBe(401);
    expect((await refresh(second.refresh_token)).body).toEqual({ error: "invalid_grant" });

    const other = await signIn(who);
    expect((await call("/oauth/revoke", "/oauth/revoke", formPost({ token: other.refresh_token, client_id: "pt-mobile" }))).status).toBe(200);
    expect((await call("/me", "/me", bearer(other.access_token))).status).toBe(401);
    // Unknown tokens are not an error (RFC 7009).
    expect((await call("/oauth/revoke", "/oauth/revoke", formPost({ token: "nope", client_id: "pt-mobile" }))).status).toBe(200);
    const audit = await admin.query<{ action: string }>("SELECT DISTINCT action FROM webauth.audit WHERE action LIKE 'device.%'");
    expect(audit.rows.map((r) => r.action)).toEqual(expect.arrayContaining(["device.approved", "device.linked", "device.token_reuse", "device.revoked"]));
  });

  it("phase 1b: the investor's distributions and a Merkle proof that rebuilds the root on chain", async () => {
    const who = await investor();
    const t = await signIn(who);
    const wallet = (await admin.query<{ w: string }>("SELECT lower(wallet_address) AS w FROM webdemo.investors WHERE id = $1", [who.id])).rows[0]?.w ?? "";
    const other = `0x${"9".repeat(40)}`;
    const token = `0x${randomBytes(20).toString("hex")}`;
    const registry = `0x${randomBytes(20).toString("hex")}`;
    // Two entitlements in statement order; WHT 15 % (rate seeded by 0021).
    const ents = [{ wallet, netPaisa: "850" }, { wallet: other, netPaisa: "425" }].sort((a, b) => (a.wallet < b.wallet ? -1 : 1));
    const statement = JSON.stringify({ kind: "pt-rent-statement-v2", entitlements: ents.map((e) => ({ ...e, units: "1" })) });
    const statementHash = keccak256(stringToBytes(statement));
    const { root } = buildTree(ents.map((e) => rentLeaf(e.wallet as Address, BigInt(e.netPaisa))));
    const rate = (await admin.query<{ id: string }>("SELECT id FROM tax.rates WHERE income_type = 'reit_dividend' AND status = 'filer' AND state = 'active' LIMIT 1")).rows[0]?.id;
    await admin.query("SET session_replication_role = replica"); // test only: a calculation as the S-03 pipeline leaves it
    const d = await admin.query<{ id: string }>(
      `INSERT INTO ops.distributions (token, period, record_date, record_block, income_type, collected, expenses, fees, reserve_contribution, reserve_release,
         distributable_gross, holders, total_units, sum_gross, sum_wht, sum_net, flagged_lines, placeholder_lines, status, calculated_by,
         merkle_root, statement, statement_hash, tax_schedule, tax_schedule_hash, attached_by, attached_at)
       VALUES ($1, '2026-10', '2026-10-31', 1, 'reit_dividend', 1500, 0, 0, 0, 0, 1500, 2, 2, 1500, 225, 1275, 0, 0, 'attached', 'ops:a',
         $2, $3, $4, '{}', $5, 'ops:b', now()) RETURNING id`,
      [token, root, statement, statementHash, keccak256(stringToBytes("{}"))],
    );
    for (const [w, gross, wht, net] of [[wallet, 1000, 150, 850], [other, 500, 75, 425]] as const) {
      await admin.query(
        `INSERT INTO ops.distribution_lines (distribution_id, wallet, units, gross, filer_status, flagged, rate_id, rate_ppm, placeholder_rate, wht, net)
         VALUES ($1, $2, 1, $3, 'filer', false, $4, 150000, true, $5, $6)`,
        [d.rows[0]?.id, w, gross, rate, wht, net],
      );
    }
    await admin.query(
      `INSERT INTO chain.distributions (registry, id, token, record_block, merkle_root, total_paisa, statement_hash, status, published_block, updated_block)
       VALUES ($1, 7, $2, 1, $3, 1275, $4, 'finalized', 2, 3)`,
      [registry, token, root, statementHash],
    );
    await admin.query("SET session_replication_role = DEFAULT");

    const list = (await call("/me/distributions", "/me/distributions", bearer(t.access_token))).body as { data: { distribution_id: string; net: { amount: string } }[] };
    expect(list.data).toEqual([expect.objectContaining({ distribution_id: "7", status: "finalized", period: "2026-10", net: { amount: "850", currency: "PKR" } })]);
    const proof = (await call("/me/distributions/{token}/{distributionId}/proof", `/me/distributions/${token}/7/proof`, bearer(t.access_token))).body as {
      leaf: string; proof: string[]; merkle_root: string; statement_matches: boolean; amount: { amount: string };
    };
    expect(proof).toMatchObject({ merkle_root: root, statement_matches: true, amount: { amount: "850" } });
    // The proof leads from the investor's leaf to the root on chain.
    expect(processProof(proof.leaf as `0x${string}`, proof.proof as `0x${string}`[])).toBe(root);
    expect(proof.proof).toHaveLength(1);
    // Another investor's distribution, or one without a line of theirs, is "not found".
    expect((await call("/me/distributions/{token}/{distributionId}/proof", `/me/distributions/${token}/8/proof`, bearer(t.access_token))).status).toBe(404);
    const stranger = await signIn(await investor());
    expect((await call("/me/distributions/{token}/{distributionId}/proof", `/me/distributions/${token}/7/proof`, bearer(stranger.access_token))).status).toBe(404);
  });

  it("phase 2a: a reservation request needs an Idempotency-Key and a valid JSON body; a closed or unknown offering is 422; others' items are 404", async () => {
    const t = await signIn(await investor());
    const post = (body: string, headers: Record<string, string>): RequestInit => ({
      method: "POST",
      headers: { authorization: `Bearer ${t.access_token}`, "content-type": "application/json", ...headers },
      body,
    });
    const R = "/me/subscription-requests";
    const ok = JSON.stringify({ offering_id: "00000000-0000-4000-8000-000000000060", units: "10" });
    expect((await call(R, R, post(ok, {}))).body).toMatchObject({ code: "idempotency_key_required" });
    expect((await call(R, R, post(ok, { "idempotency-key": "short" }))).status).toBe(400);
    expect((await call(R, R, post("{", { "idempotency-key": "key-12345678" }))).body).toMatchObject({ code: "invalid_body" });
    expect((await call(R, R, post(JSON.stringify({ offering_id: "x", units: "10" }), { "idempotency-key": "key-12345678" }))).status).toBe(400);
    expect((await call(R, R, post(JSON.stringify({ offering_id: "00000000-0000-4000-8000-000000000060", units: "10", extra: 1 }), { "idempotency-key": "key-12345678" }))).status).toBe(400);
    expect((await call(R, R, { ...post(ok, { "idempotency-key": "key-12345678" }), headers: { authorization: `Bearer ${t.access_token}`, "content-type": "text/plain", "idempotency-key": "key-12345678" } })).status).toBe(415);
    const closed = await call(R, R, post(ok, { "idempotency-key": "key-12345678" }));
    expect(closed.status).toBe(422);
    expect(closed.body).toMatchObject({ code: "offering_not_open" });
    expect((await call(R, R, { ...post(ok, { "idempotency-key": "key-12345678" }), headers: { "content-type": "application/json", "idempotency-key": "key-12345678" } })).status).toBe(401);
    expect((await call("/me/subscription-requests/{requestId}", "/me/subscription-requests/00000000-0000-4000-8000-000000000061", bearer(t.access_token))).status).toBe(404);
    expect((await call("/me/subscriptions/{subscriptionId}", "/me/subscriptions/00000000-0000-4000-8000-000000000062", bearer(t.access_token))).status).toBe(404);
    expect((await call("/me/subscriptions/{subscriptionId}", "/me/subscriptions/not-a-uuid", bearer(t.access_token))).status).toBe(404);
  });

  it("phase 2b: a change request needs an Idempotency-Key and action cancel or withdraw; an unknown or another investor's subscription is 404", async () => {
    const t = await signIn(await investor());
    const post = (body: string, headers: Record<string, string>): RequestInit => ({
      method: "POST",
      headers: { authorization: `Bearer ${t.access_token}`, "content-type": "application/json", ...headers },
      body,
    });
    const T = "/me/subscriptions/{subscriptionId}/change-requests";
    const P = "/me/subscriptions/00000000-0000-4000-8000-000000000063/change-requests";
    const cancel = JSON.stringify({ action: "cancel" });
    expect((await call(T, P, post(cancel, {}))).body).toMatchObject({ code: "idempotency_key_required" });
    expect((await call(T, P, post(JSON.stringify({ action: "sell" }), { "idempotency-key": "key-00000000" }))).body).toMatchObject({ code: "invalid_body" });
    expect((await call(T, P, post(JSON.stringify({ action: "cancel", extra: 1 }), { "idempotency-key": "key-00000000" }))).status).toBe(400);
    const unknown = await call(T, P, post(cancel, { "idempotency-key": "key-00000000" }));
    expect(unknown.status).toBe(404);
    expect(unknown.body).toMatchObject({ code: "not_found" });
    expect((await call(T, "/me/subscriptions/not-a-uuid/change-requests", post(cancel, { "idempotency-key": "key-00000000" }))).status).toBe(404);
    expect((await call(T, P, { ...post(cancel, { "idempotency-key": "key-00000000" }), headers: { "content-type": "application/json", "idempotency-key": "key-00000000" } })).status).toBe(401);
  });

  it("phase 2b part 2: an order request follows the contract, replays with its key and conflicts with another body; markets and own orders read", async () => {
    const t = await signIn(await investor());
    const post = (body: unknown, key?: string): RequestInit => ({
      method: "POST",
      headers: { authorization: `Bearer ${t.access_token}`, "content-type": "application/json", ...(key ? { "idempotency-key": key } : {}) },
      body: JSON.stringify(body),
    });
    const R = "/me/order-requests";
    const ok = { symbol: "GPF3", side: "buy", price: { amount: "50000", currency: "PKR" }, tokens: "2" };
    expect((await call(R, R, post(ok))).body).toMatchObject({ code: "idempotency_key_required" });
    expect((await call(R, R, post({ ...ok, side: "hold" }, "key-11111111"))).body).toMatchObject({ code: "invalid_body" });
    expect((await call(R, R, post({ ...ok, price: { amount: "500.5", currency: "PKR" } }, "key-11111111"))).status).toBe(400);
    expect((await call(R, R, post({ ...ok, tokens: "1000000" }, "key-11111111"))).status).toBe(400);
    const made = await call(R, R, post(ok, "key-11111111"));
    expect(made.status).toBe(201);
    const body = made.body as { id: string; total: { amount: string }; order_id: string | null; confirmation_uri_complete: string };
    expect(body).toMatchObject({ symbol: "GPF3", side: "buy", total: { amount: "100000", currency: "PKR" }, status: "pending", order_id: null });
    expect((await call(R, R, post(ok, "key-11111111"))).status).toBe(200);
    expect((await call(R, R, post({ ...ok, tokens: "3" }, "key-11111111"))).body).toMatchObject({ code: "idempotency_conflict" });
    const seen = await call("/me/order-requests/{requestId}", `/me/order-requests/${body.id}`, bearer(t.access_token));
    expect(seen.body).toMatchObject({ id: body.id, status: "pending" });
    // An order request is not a subscription request.
    expect((await call("/me/subscription-requests/{requestId}", `/me/subscription-requests/${body.id}`, bearer(t.access_token))).status).toBe(404);
    expect((await call("/me/orders", "/me/orders", bearer(t.access_token))).body).toEqual({ data: [], next_cursor: null });
    expect((await call("/markets", "/markets")).status).toBe(200);
    expect((await call("/markets/{symbol}", "/markets/NONE1")).status).toBe(404);
    expect((await call("/markets/{symbol}", "/markets/bad")).status).toBe(404);
    expect((await call("/me/orders", "/me/orders")).status).toBe(401);
  });

  it("phase 2b part 3: a cancellation request for one's own open order follows the contract; others' and unknown orders are 404", async () => {
    const who = await investor();
    const t = await signIn(who);
    const stranger = await investor();
    const order = async (investorId: string): Promise<string> =>
      (
        await admin.query<{ id: string }>(
          "INSERT INTO webdemo.orders (id, request_id, investor_id, symbol, side, price_paisa, tokens, status) VALUES (gen_random_uuid(), gen_random_uuid(), $1, 'GPF3', 'buy', 50000, 2, 'open') RETURNING id",
          [investorId],
        )
      ).rows[0]?.id ?? "";
    const mine = await order(who.id);
    const theirs = await order(stranger.id);
    const C = "/me/orders/{orderId}/cancel-requests";
    const post = (key?: string): RequestInit => ({ method: "POST", headers: { authorization: `Bearer ${t.access_token}`, ...(key ? { "idempotency-key": key } : {}) } });
    expect((await call(C, `/me/orders/${mine}/cancel-requests`, post())).body).toMatchObject({ code: "idempotency_key_required" });
    const made = await call(C, `/me/orders/${mine}/cancel-requests`, post("key-22222222"));
    expect(made.status).toBe(201);
    const body = made.body as { id: string };
    expect(made.body).toMatchObject({ kind: "order_cancel", target_order_id: mine, order_id: null, status: "pending", side: "buy", tokens: "2" });
    expect((await call(C, `/me/orders/${mine}/cancel-requests`, post("key-22222222"))).status).toBe(200);
    expect((await call(C, `/me/orders/${theirs}/cancel-requests`, post("key-22222222"))).body).toMatchObject({ code: "idempotency_conflict" });
    expect((await call(C, `/me/orders/${theirs}/cancel-requests`, post("key-33333333"))).status).toBe(404);
    expect((await call(C, "/me/orders/00000000-0000-4000-8000-000000000063/cancel-requests", post("key-33333333"))).status).toBe(404);
    expect((await call(C, "/me/orders/not-a-uuid/cancel-requests", post("key-33333333"))).status).toBe(404);
    expect((await call("/me/order-requests/{requestId}", `/me/order-requests/${body.id}`, bearer(t.access_token))).body).toMatchObject({ kind: "order_cancel", target_order_id: mine });
    expect((await call(C, `/me/orders/${mine}/cancel-requests`, { method: "POST", headers: { "idempotency-key": "key-22222222" } })).status).toBe(401);
  });

  it("phase 2b part 4: demo cash reads from the ledger; a top-up request follows the contract, replays with its key and conflicts with another amount", async () => {
    const t = await signIn(await investor());
    expect((await call("/me/cash", "/me/cash", bearer(t.access_token))).body).toEqual({
      available: { amount: "0", currency: "PKR" },
      in_orders: { amount: "0", currency: "PKR" },
      demo: true,
    });
    expect((await call("/me/cash", "/me/cash")).status).toBe(401);
    const R = "/me/topup-requests";
    const post = (body: unknown, key?: string): RequestInit => ({
      method: "POST",
      headers: { authorization: `Bearer ${t.access_token}`, "content-type": "application/json", ...(key ? { "idempotency-key": key } : {}) },
      body: JSON.stringify(body),
    });
    const ok = { amount: { amount: "500000", currency: "PKR" } };
    expect((await call(R, R, post(ok))).body).toMatchObject({ code: "idempotency_key_required" });
    expect((await call(R, R, post({ amount: { amount: "50050", currency: "PKR" } }, "key-44444444"))).body).toMatchObject({ code: "invalid_body" });
    expect((await call(R, R, post({ amount: { amount: "200000000000", currency: "PKR" } }, "key-44444444"))).status).toBe(400);
    expect((await call(R, R, post({ amount: { amount: "500000", currency: "USD" } }, "key-44444444"))).status).toBe(400);
    const made = await call(R, R, post(ok, "key-44444444"));
    expect(made.status).toBe(201);
    const body = made.body as { id: string };
    expect(made.body).toMatchObject({ kind: "topup", amount: { amount: "500000", currency: "PKR" }, status: "pending", topup_id: null });
    expect((await call(R, R, post(ok, "key-44444444"))).status).toBe(200);
    expect((await call(R, R, post({ amount: { amount: "600000", currency: "PKR" } }, "key-44444444"))).body).toMatchObject({ code: "idempotency_conflict" });
    expect((await call("/me/topup-requests/{requestId}", `/me/topup-requests/${body.id}`, bearer(t.access_token))).body).toMatchObject({ id: body.id, status: "pending" });
    expect((await call("/me/order-requests/{requestId}", `/me/order-requests/${body.id}`, bearer(t.access_token))).status).toBe(404);
    const stranger = await signIn(await investor());
    expect((await call("/me/topup-requests/{requestId}", `/me/topup-requests/${body.id}`, bearer(stranger.access_token))).status).toBe(404);
  });

  it("push devices (migration 0065): register, replace and remove the device's token; sealed for the worker only", async () => {
    const who = await investor();
    const t = await signIn(who);
    const P = "/me/push-device";
    const put = (body: unknown, token = t.access_token): RequestInit => ({
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "accept-language": "ur" },
      body: JSON.stringify(body),
    });
    const fcm = `cXVpZXQtZGV2aWNl:APA91b${"q".repeat(140)}`;
    expect((await call(P, P, put({ platform: "android", token: fcm }, "x".repeat(43)))).status).toBe(401);
    expect((await call(P, P, put({ platform: "windows", token: fcm }))).body).toMatchObject({ code: "invalid_body" });
    expect((await call(P, P, put({ platform: "android", token: "has spaces in it, not a token" }))).body).toMatchObject({ code: "invalid_body" });
    expect((await call(P, P, put({ platform: "android", token: fcm }))).status).toBe(204);
    expect((await call(P, P, put({ platform: "android", token: `${fcm}2` }))).status).toBe(204);
    const rows = await admin.query<{ recipient_id: string; lookup_hash: Buffer; sealed: Buffer; locale: string }>(
      `SELECT c.recipient_id::text, c.lookup_hash, c.sealed, r.locale FROM notify.contacts c JOIN notify.recipients r ON r.id = c.recipient_id
       WHERE c.channel = 'push' AND c.superseded_at IS NULL AND r.subject_id = (SELECT kyc_subject::text FROM webdemo.investors WHERE id = $1)`,
      [who.id],
    );
    expect(rows.rows).toHaveLength(1);
    const row = rows.rows[0];
    const opener = PushOpener.fromEnv({ NOTIFY_PUSH_PRIVATE_KEY: pushKeys.privateKey });
    expect(opener.open(row?.recipient_id ?? "", row?.lookup_hash ?? Buffer.alloc(0), row?.sealed ?? Buffer.alloc(0))).toBe(`${fcm}2`);
    const del: RequestInit = { method: "DELETE", headers: { authorization: `Bearer ${t.access_token}` } };
    expect((await call(P, P, del)).status).toBe(204);
    expect((await call(P, P, del)).status).toBe(204);
    expect((await admin.query("SELECT 1 FROM notify.contacts c JOIN notify.recipients r ON r.id = c.recipient_id WHERE c.recipient_id = $1 AND c.superseded_at IS NULL", [row?.recipient_id])).rowCount).toBe(0);

    // Without the worker's public key the server says push is not set up.
    const bare = createApiServer({
      auth: new AuthService(pgRepositories(pool).grants, "http://localhost:3100/device"),
      catalogue: new CatalogueService(pgRepositories(pool).catalogue),
      investors: new InvestorService(pgRepositories(pool).investors),
      push: new PushService(pgRepositories(pool).push, null),
      openapi: OPENAPI,
    });
    await new Promise<void>((r) => bare.listen(0, "127.0.0.1", r));
    try {
      const res = await fetch(`http://127.0.0.1:${String((bare.address() as AddressInfo).port)}/v1/me/push-device`, put({ platform: "ios", token: fcm }));
      expect(res.status).toBe(503);
      expect(((await res.json()) as { code: string }).code).toBe("push_unavailable");
    } finally {
      bare.close();
    }
  });

  it("problems: unknown path 404, wrong method 405, too many requests 429 with Retry-After", async () => {
    expect((await fetch(`${base}/v1/nothing`)).status).toBe(404);
    const m = await fetch(`${base}/v1/offerings`, { method: "DELETE" });
    expect(m.status).toBe(405);
    expect(m.headers.get("allow")).toBe("GET");
    const tight = createApiServer({
      auth: new AuthService(pgRepositories(pool).grants, "http://localhost:3100/device"),
      catalogue: new CatalogueService(pgRepositories(pool).catalogue),
      investors: new InvestorService(pgRepositories(pool).investors),
      openapi: OPENAPI,
      ratePerMinute: 2,
    });
    await new Promise<void>((r) => tight.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${String((tight.address() as AddressInfo).port)}/v1/status`;
    const codes = [(await fetch(url)).status, (await fetch(url)).status];
    const third = await fetch(url);
    tight.close();
    expect(codes).toEqual([200, 200]);
    expect(third.status).toBe(429);
    expect(third.headers.get("retry-after")).toMatch(/^[0-9]+$/);
    expect(third.headers.get("ratelimit-policy")).toBe('"default";q=2;w=60');
  });
});
