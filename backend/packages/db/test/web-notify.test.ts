import { createHash, randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../src/migrate.ts";
import { adminSettings, contiguousMigrations, scratchDatabase } from "./helpers.ts";
import { officer } from "./officers.ts";

/**
 * Migration 0030: website passkey and session producers (T-030 follow-ups: passkey added/removed,
 * a copied passkey switched off plus the officers' alert, new-device sign-in) and the investor
 * notification centre (NP-8): pt_web may execute exactly the session-bound notify.web_* functions,
 * each scoped to the investor of the live session. Driven as the website drives it (a login role
 * that is a member of pt_web only).
 */
let admin: pg.Client;
let web: pg.Client;
let drop: () => Promise<void>;
const role = `pt_web_nt_${randomBytes(4).toString("hex")}`;
const password = randomBytes(24).toString("base64url");

const sha = (s: string): Buffer => createHash("sha256").update(s, "utf8").digest();
const tok = (): string => randomBytes(32).toString("base64url");

const ALLOWED = [
  "notify.web_inbox(p_session bytea, p_locale text, p_limit integer)",
  "notify.web_mark_read(p_session bytea, p_ids bigint[])",
  "notify.web_set(p_session bytea, p_what text, p_channel text, p_enabled boolean, p_value text)",
  "notify.web_settings(p_session bytea)",
  "notify.web_unread(p_session bytea)",
];

beforeAll(async () => {
  let settings: pg.ClientConfig;
  ({ client: admin, settings, drop } = await scratchDatabase());
  await migrate(admin, contiguousMigrations());
  await admin.query(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD ${admin.escapeLiteral(password)}`);
  await admin.query(`GRANT pt_web TO ${role} WITH INHERIT TRUE, SET FALSE`);
  web = new pg.Client({ ...settings, user: role, password });
  await web.connect();
  await officer(admin, "comp.web.np", "compliance_officer");
}, 180_000);

afterAll(async () => {
  await web.end();
  await drop();
  const root = new pg.Client(adminSettings());
  await root.connect();
  await root.query(`DROP ROLE IF EXISTS ${role}`);
  await root.end();
}, 180_000);

interface Person {
  id: string;
  subject: string | null;
  session: Buffer;
}

/** A website investor (with a KYC subject unless `noKyc`), signed in through the sign-up path. */
async function person(noKyc = false): Promise<Person> {
  const subject = noKyc ? null : randomUUID();
  const { rows } = await admin.query<{ id: string }>(
    "INSERT INTO webdemo.investors (display_name, wallet_address, kyc_status, kyc_subject) VALUES ('Notify Tester', $1, 'verified', $2) RETURNING id",
    [`0x${randomBytes(20).toString("hex")}`, subject],
  );
  const id = rows[0]?.id ?? "";
  const t = tok();
  const s = await web.query<{ e: Date | null }>("SELECT webauth.web_start_session($1, $2, 'signup') AS e", [sha(t), id]);
  if (!s.rows[0]?.e) throw new Error("session refused");
  return { id, subject, session: sha(t) };
}

async function ceremony(purpose: "register" | "login" | "step_up", session: Buffer | null): Promise<Buffer> {
  const id = sha(tok());
  const { rows } = await web.query<{ r: string }>("SELECT webauth.web_create_challenge($1, $2, $3, $4) AS r", [id, purpose, tok(), session]);
  if (rows[0]?.r !== "ok") throw new Error(`challenge refused: ${rows[0]?.r ?? ""}`);
  await web.query("SELECT webauth.web_consume_challenge($1, $2, $3)", [id, purpose, session]);
  return id;
}

async function addPasskey(p: Person, name = "My phone"): Promise<string> {
  const cred = randomBytes(32).toString("base64url");
  const challenge = await ceremony("register", p.session);
  const { rows } = await web.query<{ r: string }>("SELECT webauth.web_add_passkey($1, $2, $3, $4, 0, '{internal}', $5, 'none', 'multiDevice', true, true, $6) AS r", [
    challenge,
    p.session,
    cred,
    randomBytes(77),
    randomUUID(),
    name,
  ]);
  if (rows[0]?.r !== "ok") throw new Error(`passkey refused: ${rows[0]?.r ?? ""}`);
  return cred;
}

async function login(cred: string, counter: number): Promise<Buffer | null> {
  const challenge = await ceremony("login", null);
  const t = tok();
  const { rows } = await web.query<{ i: string | null }>("SELECT webauth.web_login($1, $2, $3, $4, true, true) AS i", [challenge, sha(t), cred, counter]);
  return rows[0]?.i ? sha(t) : null;
}

async function kinds(subject: string | null, kind?: string): Promise<string[]> {
  const { rows } = await admin.query<{ kind: string }>(
    `SELECT n.kind FROM notify.notifications n JOIN notify.recipients r ON r.id = n.recipient_id
     WHERE r.subject_type = 'investor' AND r.subject_id = $1 AND ($2::text IS NULL OR n.kind = $2) ORDER BY n.id`,
    [subject, kind ?? null],
  );
  return rows.map((r) => r.kind);
}

describe("passkey and session producers (T-030)", () => {
  it("a passkey added, a first sign-in from it, a removal: one notice each; later sign-ins with it add none", async () => {
    const p = await person();
    const cred = await addPasskey(p, "Pixel 9 (Lahore)");
    expect(await kinds(p.subject)).toEqual(["security.passkey_added"]);
    const s1 = await login(cred, 1);
    expect(s1).not.toBeNull();
    await login(cred, 2);
    await login(cred, 3);
    const { rows } = await admin.query<{ params: { device: string } }>(
      "SELECT n.params FROM notify.notifications n JOIN notify.recipients r ON r.id = n.recipient_id WHERE r.subject_id = $1 AND n.kind = 'security.new_device_sign_in'",
      [p.subject],
    );
    expect(rows.map((r) => r.params.device)).toEqual(["Pixel 9 (Lahore)"]);
    // Removing needs a fresh step-up on this session.
    const step = await ceremony("step_up", s1);
    await web.query("SELECT webauth.web_step_up($1, $2, $3, 4, true, true)", [step, s1, cred]);
    const { rows: refs } = await web.query<{ ref: string }>("SELECT ref FROM webauth.web_passkeys($1)", [s1]);
    expect((await web.query<{ r: string }>("SELECT webauth.web_revoke_passkey($1, $2) AS r", [s1, refs[0]?.ref])).rows[0]?.r).toBe("ok");
    expect(await kinds(p.subject)).toEqual(["security.passkey_added", "security.new_device_sign_in", "security.passkey_removed"]);
  });

  it("a counter regression switches the passkey off: the investor is told generically, compliance gets an alert", async () => {
    const p = await person();
    const cred = await addPasskey(p);
    await login(cred, 5);
    expect(await login(cred, 5)).toBeNull();
    expect(await kinds(p.subject, "security.passkey_disabled")).toHaveLength(1);
    const { rows } = await admin.query<{ params: { topic: string; reference: string } }>(
      `SELECT n.params FROM notify.notifications n JOIN notify.recipients r ON r.id = n.recipient_id
       WHERE r.subject_type = 'officer' AND r.subject_id = 'comp.web.np' AND n.kind = 'officer.alert'`,
    );
    expect(rows.map((r) => r.params.topic)).toEqual(["passkey_clone"]);
    expect(rows[0]?.params.reference).toMatch(/^PK-[0-9A-F]{6}$/);
  });

  it("an investor without a KYC record gets no notification and no producer failure", async () => {
    const p = await person(true);
    await addPasskey(p);
    const { rows } = await admin.query<{ n: number }>("SELECT count(*)::int AS n FROM notify.producer_failures");
    expect(rows[0]?.n).toBe(0);
  });
});

describe("the investor notification centre (NP-8)", () => {
  it("pt_web can execute exactly the five notify.web_* functions and read no notify table", async () => {
    const { rows } = await admin.query<{ f: string }>(
      `SELECT n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS f
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'notify' AND has_function_privilege('pt_web', p.oid, 'EXECUTE') ORDER BY 1`,
    );
    expect(rows.map((r) => r.f)).toEqual(ALLOWED);
    const { rows: tables } = await admin.query<{ t: string }>(
      "SELECT format('%I.%I', n.nspname, c.relname) AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'notify' AND c.relkind IN ('r', 'v')",
    );
    expect(tables.length).toBeGreaterThan(10);
    for (const { t } of tables) await expect(web.query(`SELECT 1 FROM ${t} LIMIT 1`)).rejects.toMatchObject({ code: "42501" });
    await expect(web.query("SELECT notify.enqueue('k-12345678', 'security.passkey_added', 'investor', $1, '{}', 'x')", [randomUUID()])).rejects.toMatchObject({ code: "42501" });
    await expect(web.query("SELECT notify.web_recipient($1, true)", [randomBytes(32)])).rejects.toMatchObject({ code: "42501" });
  });

  it("lists only the signed-in investor's notices with the template in the chosen language; marks read once; another session cannot touch them", async () => {
    const a = await person();
    const b = await person();
    await addPasskey(a);
    await admin.query("SELECT notify.enqueue($1, 'offering.waitlisted', 'investor', $2, '{\"offering\": \"Gulberg Heights\"}', 'producer:test')", [`t:${randomUUID()}`, a.subject]);
    await admin.query("SELECT notify.enqueue($1, 'marketing.offering_open', 'investor', $2, '{\"offering\": \"Gulberg Heights\"}', 'producer:test')", [`t:${randomUUID()}`, a.subject]);
    const inbox = await web.query<{ id: string; kind: string; params: Record<string, string>; placeholders: Record<string, { type: string }>; read_at: Date | null; subject: string; body: string }>(
      "SELECT * FROM notify.web_inbox($1, 'ur', 20)",
      [a.session],
    );
    // Newest first; the marketing notice without consent is not shown.
    expect(inbox.rows.map((r) => r.kind)).toEqual(["offering.waitlisted", "security.passkey_added"]);
    expect(inbox.rows[0]?.subject).toMatch(/[؀-ۿ]/);
    expect(inbox.rows[0]?.body).toContain("{{offering}}");
    expect(inbox.rows[0]?.placeholders).toEqual({ offering: { type: "label" } });
    expect((await web.query("SELECT * FROM notify.web_inbox($1, 'en', 20)", [b.session])).rows).toEqual([]);
    const unread = async (s: Buffer): Promise<number> => (await web.query<{ n: number }>("SELECT notify.web_unread($1) AS n", [s])).rows[0]?.n ?? -1;
    expect(await unread(a.session)).toBe(2);
    const ids = inbox.rows.map((r) => r.id);
    expect((await web.query<{ n: number }>("SELECT notify.web_mark_read($1, $2::bigint[]) AS n", [b.session, ids])).rows[0]?.n).toBe(0);
    expect((await web.query<{ n: number }>("SELECT notify.web_mark_read($1, $2::bigint[]) AS n", [a.session, [ids[0]]])).rows[0]?.n).toBe(1);
    expect(await unread(a.session)).toBe(1);
    expect((await web.query<{ n: number }>("SELECT notify.web_mark_read($1, NULL) AS n", [a.session])).rows[0]?.n).toBe(1);
    expect((await web.query<{ n: number }>("SELECT notify.web_mark_read($1, NULL) AS n", [a.session])).rows[0]?.n).toBe(0);
    expect(await unread(a.session)).toBe(0);
    await expect(admin.query("DELETE FROM notify.inbox_reads")).rejects.toThrow(/append-only/);
    // After logout nothing is readable or writable.
    await web.query("SELECT webauth.web_end_session($1)", [a.session]);
    expect((await web.query("SELECT * FROM notify.web_inbox($1, 'en', 20)", [a.session])).rows).toEqual([]);
    expect((await web.query<{ r: string }>("SELECT notify.web_set($1, 'locale', NULL, NULL, 'ur') AS r", [a.session])).rows[0]?.r).toBe("session");
  });

  it("settings: defaults, transactional switches, marketing opt-in with the consent version, language; refusals", async () => {
    const p = await person();
    const settings = async () => (await web.query("SELECT * FROM notify.web_settings($1)", [p.session])).rows[0] as Record<string, unknown>;
    expect(await settings()).toEqual({
      locale: "en",
      sms_on_file: false,
      email_on_file: false,
      sms_enabled: true,
      email_enabled: true,
      sms_marketing: false,
      email_marketing: false,
      marketing_version: null,
    });
    const set = async (what: string, channel: string | null, enabled: boolean | null, value: string | null): Promise<string> =>
      (await web.query<{ r: string }>("SELECT notify.web_set($1, $2, $3, $4, $5) AS r", [p.session, what, channel, enabled, value])).rows[0]?.r ?? "";
    expect(await set("transactional", "sms", false, null)).toBe("ok");
    expect(await set("transactional", "sms", false, null)).toBe("ok");
    expect(await set("marketing", "email", true, "mkt-2026-10")).toBe("ok");
    expect(await set("locale", null, null, "ur")).toBe("ok");
    expect(await set("marketing", "email", true, "Not valid")).toBe("invalid");
    expect(await set("transactional", "push", true, null)).toBe("invalid");
    expect(await set("security", "sms", false, null)).toBe("invalid");
    expect(await set("locale", null, null, "fr")).toBe("invalid");
    expect(await settings()).toMatchObject({ locale: "ur", sms_enabled: false, email_enabled: true, email_marketing: true, sms_marketing: false, marketing_version: "mkt-2026-10" });
    // Only changes are written (one preference row although the switch was sent twice), each audited.
    const { rows } = await admin.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM notify.preferences p JOIN notify.recipients r ON r.id = p.recipient_id WHERE r.subject_id = $1",
      [p.subject],
    );
    expect(rows[0]?.n).toBe(1);
    expect((await admin.query("SELECT * FROM notify.verify_audit()")).rows).toEqual([]);
    // Without a KYC record there is nothing to configure.
    const nobody = await person(true);
    expect((await web.query("SELECT * FROM notify.web_settings($1)", [nobody.session])).rows).toEqual([]);
    expect((await web.query<{ r: string }>("SELECT notify.web_set($1, 'locale', NULL, NULL, 'ur') AS r", [nobody.session])).rows[0]?.r).toBe("session");
  });
});
