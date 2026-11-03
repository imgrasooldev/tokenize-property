import { createHash, randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../src/migrate.ts";
import { adminSettings, contiguousMigrations, scratchDatabase } from "./helpers.ts";

/**
 * Migration 0053 (AN-1, AN-2): the website learns only one neutral word about the signed-in
 * investor's own review state ('review' or 'expired'), through webnotice.account_notice as pt_web;
 * never a reason, a case or another investor's state, and never kyc.* directly.
 */
let admin: pg.Client;
let web: pg.Client;
let drop: () => Promise<void>;
const role = `pt_web_an_${randomBytes(4).toString("hex")}`;
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

/** An investor with a KYC subject, a website session and the given latest KYC decision. */
async function investor(decision: "verified" | "expired" | "review" | null): Promise<Buffer> {
  const k = await admin.query<{ id: string }>("SELECT kyc.register_subject($1::bytea[], '{1}'::smallint[], $2, $3, '1234', 'kyc-service') AS id", [
    [randomBytes(32)],
    randomBytes(32),
    randomBytes(60),
  ]);
  const subject = k.rows[0]?.id ?? "";
  if (decision === "verified" || decision === "expired") {
    await admin.query("INSERT INTO kyc.decisions (subject_id, status, reason, basis, valid_until, decided_by) VALUES ($1, 'verified', 'test decision', '{}', $2, 'kyc-service')", [
      subject,
      decision === "verified" ? new Date(Date.now() + 365 * 86_400_000) : new Date(Date.now() - 86_400_000),
    ]);
  } else if (decision === "review") {
    await admin.query("INSERT INTO kyc.decisions (subject_id, status, reason, basis, decided_by) VALUES ($1, 'review', 'possible list match', '{}', 'kyc-service')", [subject]);
  }
  const { rows } = await admin.query<{ id: string }>(
    "INSERT INTO webdemo.investors (display_name, wallet_address, kyc_status, kyc_subject) VALUES ('Notice Tester', $1, 'verified', $2) RETURNING id",
    [`0x${randomBytes(20).toString("hex")}`, subject],
  );
  const t = randomBytes(32).toString("base64url");
  await web.query("SELECT webauth.web_start_session($1, $2, 'signup')", [sha(t), rows[0]?.id]);
  return sha(t);
}

const notice = async (session: Buffer): Promise<string | null> => (await web.query<{ n: string | null }>("SELECT webnotice.account_notice($1) AS n", [session])).rows[0]?.n ?? null;

describe("the investor's own review notice (0053)", () => {
  it("one neutral word per state, never the reason", async () => {
    expect(await notice(await investor("verified"))).toBeNull();
    expect(await notice(await investor(null))).toBeNull();
    expect(await notice(await investor("expired"))).toBe("expired");
    expect(await notice(await investor("review"))).toBe("review");
  });

  it("without a live session nothing is said; the website cannot read kyc directly", async () => {
    expect(await notice(randomBytes(32))).toBeNull();
    await expect(web.query("SELECT kyc.subject_status(gen_random_uuid())")).rejects.toMatchObject({ code: "42501" });
  });
});
