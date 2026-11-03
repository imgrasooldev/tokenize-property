import { createHash, randomBytes } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { authHeaders, type Client } from "@pt/http-auth";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { officer, type TestOfficer } from "../../db/test/officers.ts";
import { DemoTitleFetch } from "../src/demo-titles.ts";
import { ADMIN_BANK_SCOPE, createPayeeServer, WEB_BANK_SCOPE } from "../src/http.ts";
import { makeIban } from "../src/iban.ts";
import { BankService } from "../src/service.ts";
import { ESCROW, world, type World } from "./setup.ts";

/**
 * Migration 0055 AP-1..AP-4 on a scratch database: an operations maker gets a one-time ticket from
 * the admin database, PT Control hands the IBAN with it to the bank service (client "admin"), the
 * account waits as a pending request, and a different operations checker approves it; approval is
 * bank.register_payee as for the website (72-hour cooling-off). The portal never sees the IBAN again.
 */
const admin: Client = { id: "admin", secret: Buffer.alloc(32, 8), scope: ADMIN_BANK_SCOPE };
const web: Client = { id: "web", secret: Buffer.alloc(32, 7), scope: WEB_BANK_SCOPE };
let w: World;
let server: Server;
let base: string;
let portal: pg.Client;
let maker: TestOfficer;
let checker: TestOfficer;
let seq = 0;

beforeAll(async () => {
  w = await world();
  const bank = new BankService(w.servicePool, w.peppers, w.dataKey, new DemoTitleFetch(), { escrowAccount: ESCROW, actor: "bank-payees" });
  server = createPayeeServer(bank, [web, admin]);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  portal = new pg.Client(w.settings);
  await portal.connect();
  await portal.query("SET ROLE pt_admin_portal");
  maker = await officer(w.db, "payee.maker", "ops_maker");
  checker = await officer(w.db, "payee.checker", "ops_checker");
}, 120_000);

afterAll(async () => {
  server.close();
  await portal.end();
  await w.drop();
});

async function subject(name: string): Promise<{ id: string; ref: string }> {
  seq++;
  const r = await w.kyc.onboard({ cnic: `35204${String(3_000_000 + seq).slice(-7)}${String(1 + (seq % 7))}`, fullName: name, livenessSessionId: `sess-ap-${String(seq).padStart(4, "0")}` });
  return { id: r.subjectId, ref: r.subjectId.replace(/-/g, "").slice(0, 8) };
}

type R = { ok: boolean; id?: number; status?: string; error?: string; ref?: string };

async function ticket(o: TestOfficer, ref: string): Promise<{ r: R; token: string }> {
  const token = randomBytes(32).toString("base64url");
  const hash = createHash("sha256").update(Buffer.from(token, "base64url")).digest();
  const { rows } = await portal.query<{ r: R }>("SELECT admin.assisted_payee_ticket($1, $2, 'investor called from the number on file', $3) AS r", [o.sessionHash, ref, hash]);
  return { r: rows[0]?.r ?? { ok: false }, token };
}

async function assisted(token: string, iban: string, title: string, client: Client = admin, path = "/v1/payees/assisted"): Promise<{ status: number; body: Record<string, string> }> {
  const b = JSON.stringify({ ticket: token, iban, title });
  const res = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", ...authHeaders(client, "POST", path, b) }, body: b });
  return { status: res.status, body: (await res.json()) as Record<string, string> };
}

async function decide(o: TestOfficer, id: string, decision: "approve" | "reject"): Promise<R> {
  const d = await portal.query<{ v: { digest: string; blockers: string[] } }>("SELECT admin.assisted_payee($1, $2) AS v", [o.sessionHash, id]);
  const { rows } = await portal.query<{ r: R }>("SELECT admin.decide_assisted_payee($1, $2, $3, 'called the investor back, account confirmed', $4) AS r", [
    o.sessionHash, id, decision, Buffer.from(d.rows[0]?.v.digest ?? "", "hex"),
  ]);
  return rows[0]?.r ?? { ok: false };
}

describe("assisted payout-account change (migration 0055)", () => {
  it("ticket -> pending request -> a different officer approves -> registered with the 72-hour cooling-off", async () => {
    const s = await subject("Sana Malik");
    const iban = makeIban("MEZN", "7100000000000001");
    // The checker cannot issue a ticket (operations.request); the web client cannot use the assisted path.
    expect((await portal.query("SELECT admin.assisted_payee_ticket($1, $2, 'investor called from the number on file', $3)", [checker.sessionHash, s.ref, randomBytes(32)]).catch((e: unknown) => (e as { code?: string }).code))).toBe("42501");
    const t = await ticket(maker, s.ref);
    expect(t.r).toMatchObject({ ok: true, ref: s.ref });
    expect((await assisted(t.token, iban, "Sana Malik", web)).status).toBe(403);
    // A wrong title is refused at once; the refusal stores nothing, so the ticket stays usable for its 2 minutes.
    expect(await assisted(t.token, iban, "Someone Else")).toEqual({ status: 422, body: { error: "title_mismatch" } });
    const ok = await assisted(t.token, iban, "Sana Malik");
    expect(ok.status).toBe(200);
    const id = ok.body.requestId ?? "";
    // A ticket is used once.
    expect(await assisted(t.token, iban, "Sana Malik")).toEqual({ status: 403, body: { error: "ticket_invalid" } });
    // One open request per investor.
    const t3 = await ticket(maker, s.ref);
    expect(t3.r.error).toMatch(/already waiting for a decision/);
    expect((await w.db.query("SELECT 1 FROM bank.payees WHERE subject_id = $1", [s.id])).rowCount).toBe(0);

    // The maker holds no operations.decide.
    expect(await decide(maker, id, "approve").catch((e: unknown) => (e as { code?: string }).code)).toBe("42501");
    expect(await decide(checker, id, "approve")).toMatchObject({ ok: true, status: "approved" });
    const p = await w.db.query<{ last4: string; cooling: boolean; by: string }>(
      "SELECT iban_last4 AS last4, active_from = registered_at + interval '72 hours' AS cooling, registered_by AS by FROM bank.payees WHERE subject_id = $1 AND superseded_at IS NULL",
      [s.id],
    );
    expect(p.rows).toEqual([{ last4: iban.slice(-4), cooling: true, by: "payee.checker" }]);
    const view = await portal.query<{ v: unknown }>("SELECT admin.assisted_payee($1, $2) AS v", [checker.sessionHash, id]);
    expect(JSON.stringify(view.rows[0]?.v)).not.toContain(iban);
    expect((await w.db.query("SELECT * FROM bank.verify_audit()")).rows).toEqual([]);
  });

  it("a rejected request registers nothing; requests and tickets are never edited", async () => {
    const s = await subject("Hamid Raza");
    const t = await ticket(maker, s.ref);
    const ok = await assisted(t.token, makeIban("HABB", "7200000000000002"), "Hamid Raza");
    expect(await decide(checker, ok.body.requestId ?? "", "reject")).toMatchObject({ ok: true, status: "rejected" });
    expect((await w.db.query("SELECT 1 FROM bank.payees WHERE subject_id = $1", [s.id])).rowCount).toBe(0);
    await expect(w.db.query("UPDATE bank.assisted_payee_requests SET iban_last4 = '0000' WHERE id = $1", [ok.body.requestId])).rejects.toThrow(/decided once/);
    await expect(w.db.query("DELETE FROM bank.assist_tickets")).rejects.toThrow(/never deleted/);
  });
});
