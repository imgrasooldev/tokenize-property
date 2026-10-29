import { createHash, randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../src/migrate.ts";
import { adminSettings, contiguousMigrations, scratchDatabase } from "./helpers.ts";

/**
 * Migration 0035 (TC-1..TC-3): the website lists and downloads the signed-in investor's tax
 * certificates through session-bound tax.web_* functions only; the downloaded text is exactly what
 * was hashed at issue; another investor's certificate reads as not found; downloads are audited.
 */
let admin: pg.Client;
let web: pg.Client;
let drop: () => Promise<void>;
const role = `pt_web_tc_${randomBytes(4).toString("hex")}`;
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
}, 180_000);

afterAll(async () => {
  await web.end();
  await drop();
  const root = new pg.Client(adminSettings());
  await root.connect();
  await root.query(`DROP ROLE IF EXISTS ${role}`);
  await root.end();
}, 180_000);

async function investor(): Promise<{ subject: string; session: Buffer }> {
  const k = await admin.query<{ id: string }>("SELECT kyc.register_subject($1::bytea[], '{1}'::smallint[], $2, $3, '1234', 'kyc-service') AS id", [
    [randomBytes(32)],
    randomBytes(32),
    randomBytes(60),
  ]);
  const subject = k.rows[0]?.id ?? "";
  const { rows } = await admin.query<{ id: string }>(
    "INSERT INTO webdemo.investors (display_name, wallet_address, kyc_status, kyc_subject) VALUES ('Tax Tester', $1, 'verified', $2) RETURNING id",
    [`0x${randomBytes(20).toString("hex")}`, subject],
  );
  const t = randomBytes(32).toString("base64url");
  await web.query("SELECT webauth.web_start_session($1, $2, 'signup')", [sha(t), rows[0]?.id]);
  return { subject, session: sha(t) };
}

/** The certificate as the tax desk issues it (tax.issue_certificate: content, hash and audit entry). */
async function issue(subject: string, year: number): Promise<string> {
  const { rows } = await admin.query<{ id: string }>("SELECT tax.issue_certificate($1, $2, 'operator:tax-desk')::text AS id", [subject, year]);
  return rows[0]?.id ?? "";
}

describe("tax certificates on the website (0035)", () => {
  it("lists and downloads only the session's certificates; the text matches its SHA-256; downloads are audited", async () => {
    const a = await investor();
    const b = await investor();
    const older = await issue(a.subject, 2025);
    const second = await issue(a.subject, 2026);
    const theirs = await issue(b.subject, 2026);

    const list = await web.query<{ id: string; superseded_by: string | null; sha256: string }>("SELECT * FROM tax.web_certificates($1)", [a.session]);
    expect(list.rows.map((r) => [r.id, r.superseded_by])).toEqual([
      [second, null],
      [older, null],
    ]);
    const c = (await web.query<{ c: { contentText: string; sha256: string; superseded: boolean } | null }>("SELECT tax.web_certificate($1, $2) AS c", [a.session, second])).rows[0]?.c;
    expect(c?.superseded).toBe(false);
    expect(createHash("sha256").update(c?.contentText ?? "", "utf8").digest("hex")).toBe(c?.sha256);
    expect((await web.query<{ c: unknown }>("SELECT tax.web_certificate($1, $2) AS c", [a.session, theirs])).rows[0]?.c).toBeNull();
    expect((await web.query<{ c: unknown }>("SELECT tax.web_certificate($1, $2) AS c", [randomBytes(32), second])).rows[0]?.c).toBeNull();
    expect((await web.query("SELECT * FROM tax.web_certificates($1)", [randomBytes(32)])).rowCount).toBe(0);
    const audit = await admin.query("SELECT 1 FROM ops.audit WHERE action = 'certificate.downloaded' AND (detail->>'certificate')::bigint = $1", [second]);
    expect(audit.rowCount).toBe(1);
    expect((await admin.query("SELECT * FROM ops.verify_audit()")).rows).toEqual([]);
  });

  it("the website reaches nothing else of the tax schema", async () => {
    const code = async (sql: string) => web.query(sql).then(
        () => "ok",
        (e: unknown) => (e as { code?: string }).code,
      );
    expect(await code("SELECT * FROM tax.certificates")).toBe("42501");
    expect(await code("SELECT tax.web_subject(NULL)")).toBe("42501");
    expect(await code("SELECT tax.certificate_data(gen_random_uuid(), 2026)")).toBe("42501");
  });
});
