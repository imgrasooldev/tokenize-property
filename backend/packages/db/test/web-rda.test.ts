import { createHash, randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../src/migrate.ts";
import { adminSettings, contiguousMigrations, scratchDatabase } from "./helpers.ts";

/**
 * Spec S-08 on the website side (migrations 0056, 0057), called as pt_web: the investor's own
 * residency (webnotice.residency), the "being reviewed" notice while two compliance officers have
 * not approved, and the waiting sign-ups that may start their on-chain onboarding
 * (webnotice.waiting_onboard) only once the review is approved.
 */
let admin: pg.Client;
let web: pg.Client;
let drop: () => Promise<void>;
const role = `pt_web_rda_${randomBytes(4).toString("hex")}`;
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

/** A verified investor living in the UAE, signed up and waiting, with a website session. */
async function abroad(): Promise<{ subject: string; investor: string; session: Buffer }> {
  const k = await admin.query<{ id: string }>("SELECT kyc.register_subject($1::bytea[], '{1}'::smallint[], $2, $3, '4321', 'kyc-service') AS id", [
    [randomBytes(32)],
    randomBytes(32),
    randomBytes(60),
  ]);
  const subject = k.rows[0]?.id ?? "";
  await admin.query("INSERT INTO kyc.decisions (subject_id, status, reason, basis, valid_until, decided_by) VALUES ($1, 'verified', 'test decision', '{}', $2, 'kyc-service')", [
    subject,
    new Date(Date.now() + 365 * 86_400_000),
  ]);
  await admin.query("SELECT kyc.record_residency($1, 'non_resident', 'nicop', 784::smallint, 'kyc-service')", [subject]);
  const { rows } = await admin.query<{ id: string }>(
    "INSERT INTO webdemo.investors (display_name, wallet_address, kyc_status, kyc_subject, onboard_step) VALUES ('Abroad Tester', $1, 'pending', $2, 'waiting') RETURNING id",
    [`0x${randomBytes(20).toString("hex")}`, subject],
  );
  const t = randomBytes(32).toString("base64url");
  await web.query("SELECT webauth.web_start_session($1, $2, 'signup')", [sha(t), rows[0]?.id]);
  return { subject, investor: rows[0]?.id ?? "", session: sha(t) };
}

const waiting = async (): Promise<string[]> => (await web.query<{ investor_id: string }>("SELECT investor_id FROM webnotice.waiting_onboard()")).rows.map((r) => r.investor_id);

describe("Roshan Digital Account investors on the website (S-08, 0057)", () => {
  it("the investor sees their residency and 'review'; onboarding waits until two officers approve", async () => {
    const a = await abroad();
    const r = await web.query<{ r: unknown }>("SELECT webnotice.residency($1) AS r", [a.session]);
    expect(r.rows[0]?.r).toEqual({ status: "non_resident", document: "nicop", country: 784, payoutKind: null });
    expect((await web.query<{ n: string | null }>("SELECT webnotice.account_notice($1) AS n", [a.session])).rows[0]?.n).toBe("review");
    expect(await waiting()).not.toContain(a.investor);

    // Two officers (command-line names outside the portal, test only) approve the review.
    const id = (await admin.query<{ id: string }>("SELECT id FROM compliance.residency_reviews WHERE subject_id = $1", [a.subject])).rows[0]?.id;
    await admin.query("SELECT compliance.residency_act($1, 'officer:one', 'propose', 'NICOP and residence permit checked')", [id]);
    await admin.query("SELECT compliance.residency_act($1, 'officer:two', 'confirm', 'documents checked a second time')", [id]);
    expect(await waiting()).toContain(a.investor);
    expect((await web.query<{ n: string | null }>("SELECT webnotice.account_notice($1) AS n", [a.session])).rows[0]?.n).toBeNull();
  });

  it("a resident reads Pakistan; without a session nothing; the website still cannot read kyc or compliance", async () => {
    expect((await web.query<{ r: unknown }>("SELECT webnotice.residency($1) AS r", [randomBytes(32)])).rows[0]?.r).toBeNull();
    await expect(web.query("SELECT * FROM compliance.residency_reviews")).rejects.toMatchObject({ code: "42501" });
    await expect(web.query("SELECT kyc.is_non_resident(gen_random_uuid())")).rejects.toMatchObject({ code: "42501" });
    await expect(web.query("UPDATE webdemo.investors SET onboard_step = 'bogus'")).rejects.toThrow();
  });
});
