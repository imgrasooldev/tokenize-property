import { createHash, randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../src/migrate.ts";
import { adminSettings, contiguousMigrations, scratchDatabase } from "./helpers.ts";
import { officer, type TestOfficer } from "./officers.ts";

/**
 * Migration 0040 (CP-1..CP-5): investors file and follow complaints through session-bound
 * complaints.web_* functions only; officers acknowledge, reply, resolve and refer in PT Control
 * with complaints.handle and a step-up; a referral reads "under review" to the investor; free
 * text refuses CNIC-like numbers; history cannot be rewritten.
 */
let admin: pg.Client;
let web: pg.Client;
let drop: () => Promise<void>;
let support: TestOfficer;
let auditor: TestOfficer;
const role = `pt_web_cp_${randomBytes(4).toString("hex")}`;
const password = randomBytes(24).toString("base64url");
const sha = (s: string): Buffer => createHash("sha256").update(s, "utf8").digest();

beforeAll(async () => {
  let settings: pg.ClientConfig;
  ({ client: admin, settings, drop } = await scratchDatabase());
  await migrate(admin, contiguousMigrations());
  await admin.query(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD ${admin.escapeLiteral(password)}`);
  await admin.query(`GRANT pt_web TO ${role} WITH INHERIT TRUE, SET FALSE`);
  web = new pg.Client({ ...settings, user: role, password });
  await web.connect();
  support = await officer(admin, "support.cp.one", "support_agent");
  auditor = await officer(admin, "auditor.cp.one", "auditor");
}, 180_000);

afterAll(async () => {
  await web.end();
  await drop();
  const root = new pg.Client(adminSettings());
  await root.connect();
  await root.query(`DROP ROLE IF EXISTS ${role}`);
  await root.end();
}, 180_000);

async function investor(): Promise<Buffer> {
  const { rows } = await admin.query<{ id: string }>(
    "INSERT INTO webdemo.investors (display_name, wallet_address, kyc_status) VALUES ('Complaint Tester', $1, 'verified') RETURNING id",
    [`0x${randomBytes(20).toString("hex")}`],
  );
  const t = randomBytes(32).toString("base64url");
  await web.query("SELECT webauth.web_start_session($1, $2, 'signup')", [sha(t), rows[0]?.id]);
  return sha(t);
}

const code = (p: Promise<unknown>) =>
  p.then(
    () => "ok",
    (e: unknown) => (e as { code?: string }).code,
  );
type Act = { ok?: boolean; status?: string; error?: string };
const act = async (o: TestOfficer, id: string, action: string, body: string | null) =>
  (await admin.query<{ r: Act }>("SELECT admin.complaint_act($1, $2, $3, $4) AS r", [o.sessionHash, id, action, body])).rows[0]?.r ?? {};

describe("complaints (0040)", () => {
  it("file -> acknowledge -> reply -> resolve -> close, both sides see the same history", async () => {
    const me = await investor();
    const filed = (await web.query<{ r: { id: string; ref: string } }>("SELECT complaints.web_file($1, 'payout', 'Rent not received', 'My September rent has not arrived yet.') AS r", [me])).rows[0]?.r;
    expect(filed?.ref).toMatch(/^CMP-[0-9A-F]{8}$/);
    const id = String(filed?.id);
    expect(await act(support, id, "acknowledge", "We are checking with the bank.")).toMatchObject({ ok: true, status: "acknowledged" });
    await web.query("SELECT complaints.web_act($1, $2, 'reply', 'Thank you, waiting.')", [me, id]);
    expect((await act(support, id, "resolve", "short")).error).toMatch(/10 to 1000/);
    expect(await act(support, id, "resolve", "The bank returned the payment; it was sent again on 30 October.")).toMatchObject({ ok: true, status: "resolved" });
    const seen = (await web.query<{ c: { status: string; messages: { from: string; author: string | null }[]; events: { action: string; actor: string | null }[] } }>(
      "SELECT complaints.web_case($1, $2) AS c", [me, id])).rows[0]?.c;
    expect(seen?.status).toBe("resolved");
    expect(seen?.messages.map((m) => m.from)).toEqual(["investor", "officer", "investor"]);
    expect(seen?.messages.every((m) => m.author === null)).toBe(true);
    expect(seen?.events.map((e) => e.action)).toEqual(["filed", "acknowledged", "replied", "resolved"]);
    expect((await web.query<{ r: { status: string } }>("SELECT complaints.web_act($1, $2, 'close', NULL) AS r", [me, id])).rows[0]?.r.status).toBe("closed");
    expect(await code(web.query("SELECT complaints.web_act($1, $2, 'reply', 'one more thing')", [me, id]))).toBe("23514");
    const list = (await admin.query<{ v: { cases: { id: number; status: string }[] } }>("SELECT admin.complaints($1) AS v", [auditor.sessionHash])).rows[0]?.v;
    expect(list?.cases.find((x) => String(x.id) === id)?.status).toBe("closed");
  });

  it("a referral reads 'under review' to the investor; other investors and readers cannot act", async () => {
    const me = await investor();
    const other = await investor();
    const id = String((await web.query<{ r: { id: string } }>("SELECT complaints.web_file($1, 'account', 'Account blocked', 'I cannot reserve units any more.') AS r", [me])).rows[0]?.r.id);
    expect(await act(support, id, "refer", null)).toMatchObject({ ok: true, status: "referred" });
    const seen = (await web.query<{ c: { status: string; events: { action: string }[] } }>("SELECT complaints.web_case($1, $2) AS c", [me, id])).rows[0]?.c;
    expect(seen?.status).toBe("under_review");
    expect(JSON.stringify(seen)).not.toMatch(/referred|compliance/);
    expect((await web.query<{ c: unknown }>("SELECT complaints.web_case($1, $2) AS c", [other, id])).rows[0]?.c).toBeNull();
    expect(await code(web.query("SELECT complaints.web_act($1, $2, 'reply', 'not mine')", [other, id]))).toBe("P0002");
    expect(await code(admin.query("SELECT admin.complaint_act($1, $2, 'reply', 'auditors only read')", [auditor.sessionHash, id]))).toBe("42501");
  });

  it("free text refuses CNIC-like numbers; history cannot be rewritten; the website reaches nothing else", async () => {
    const me = await investor();
    expect(await code(web.query("SELECT complaints.web_file($1, 'other', 'My CNIC', 'It is 3520212345678 please check')", [me]))).toBe("23514");
    const id = String((await web.query<{ r: { id: string } }>("SELECT complaints.web_file($1, 'website', 'Page slow', 'The portfolio page is slow.') AS r", [me])).rows[0]?.r.id);
    expect(await code(admin.query("UPDATE complaints.messages SET body = 'rewritten' WHERE case_id = $1", [id]))).toBe("42501");
    expect(await code(admin.query("UPDATE complaints.cases SET title = 'rewritten title' WHERE id = $1", [id]))).toBe("42501");
    expect(await code(web.query("SELECT * FROM complaints.cases"))).toBe("42501");
    expect(await code(web.query("SELECT admin.complaints($1)", [randomBytes(32)]))).toBe("42501");
    expect((await web.query<{ r: unknown }>("SELECT complaints.web_file($1, 'other', 'Hello there', 'No session here at all.') AS r", [randomBytes(32)])).rows[0]?.r).toEqual({ error: "session" });
  });
});
