import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../src/migrate.ts";
import { adminSettings, contiguousMigrations, scratchDatabase } from "./helpers.ts";

/**
 * Migration 0022 WA-1/WA-2: the website's role (pt_web) may execute exactly four read functions of
 * the bank, property and recon schemas and nothing else there; bank.web_payees returns one subject's
 * payout accounts without the IBAN hash or the sealed IBAN.
 */
const role = `pt_web_acct_${randomBytes(4).toString("hex")}`;
const password = randomBytes(24).toString("base64url");
let admin: pg.Client;
let drop: () => Promise<void>;
let web: pg.Client;

const ALLOWED = ["bank.web_payees(p_subject uuid)", "property.web_catalog()", "property.web_documents(p_offering uuid)", "recon.web_status()"];

beforeAll(async () => {
  let settings: pg.ClientConfig;
  ({ client: admin, settings, drop } = await scratchDatabase());
  // The real directory has a numbering gap (0020/0021 reserved) that the runner refuses.
  await migrate(admin, contiguousMigrations());
  await admin.query(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD ${admin.escapeLiteral(password)}`);
  await admin.query(`GRANT pt_web TO ${role} WITH INHERIT TRUE, SET FALSE`);
  web = new pg.Client({ ...settings, user: role, password });
  await web.connect();
}, 120_000);

afterAll(async () => {
  await web.end();
  await drop();
  const root = new pg.Client(adminSettings());
  await root.connect();
  await root.query(`DROP ROLE IF EXISTS ${role}`);
  await root.end();
});

async function denied(sql: string, params: unknown[] = []): Promise<void> {
  await expect(web.query(sql, params)).rejects.toMatchObject({ code: "42501" });
}

describe("the website's account functions (migration 0022)", () => {
  it("pt_web can execute exactly the four web functions of bank, property and recon (directly or via PUBLIC)", async () => {
    const { rows } = await admin.query<{ f: string }>(
      `SELECT n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS f
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname IN ('bank', 'property', 'recon') AND p.prokind IN ('f', 'p')
         AND has_function_privilege('pt_web', p.oid, 'EXECUTE')
       ORDER BY 1`,
    );
    expect(rows.map((r) => r.f)).toEqual(ALLOWED);
    // The same holds for a login role that is a member of pt_web.
    const { rows: viaMember } = await admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname IN ('bank', 'property', 'recon') AND has_function_privilege($1, p.oid, 'EXECUTE')`,
      [role],
    );
    expect(viaMember[0]?.n).toBe(String(ALLOWED.length));
  });

  it("can call the four functions", async () => {
    await web.query("SELECT * FROM bank.web_payees($1)", [randomUUID()]);
    await web.query("SELECT * FROM property.web_catalog()");
    await web.query("SELECT * FROM property.web_documents($1)", [randomUUID()]);
    await web.query("SELECT * FROM recon.web_status()");
  });

  it("cannot read any table or view of bank, property or recon", async () => {
    const { rows } = await admin.query<{ t: string }>(
      `SELECT format('%I.%I', n.nspname, c.relname) AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname IN ('bank', 'property', 'recon') AND c.relkind IN ('r', 'v', 'm', 'p') ORDER BY 1`,
    );
    expect(rows.length).toBeGreaterThan(10);
    for (const { t } of rows) await denied(`SELECT 1 FROM ${t} LIMIT 1`);
  });

  it.each([
    ["register a payout account", "SELECT bank.register_payee($1, '\\x00', '\\x00', '0000', 'MEZN', '\\x00', 'web')", [randomUUID()]],
    ["call the document type allow-list directly", "SELECT property.web_public_doc_type('title_deed')", []],
    ["read the payout gate directly", "SELECT * FROM recon.payout_gate()", []],
  ])("cannot %s", async (_label, sql, params) => {
    await denied(sql, params);
  });

  it("bank.web_payees returns only the given subject's accounts and never the IBAN hash or sealed IBAN", async () => {
    const subjects = [randomUUID(), randomUUID()];
    for (const [i, s] of subjects.entries()) {
      // Fixture rows written by the administrator (the KYC and bank services do this in production).
      await admin.query("INSERT INTO kyc.subjects (id, name_hash, name_enc, pepper_version, cnic_last4, created_by) VALUES ($1, $2, $3, 1, '1234', 'test')", [
        s, randomBytes(32), randomBytes(48),
      ]);
      await admin.query(
        "INSERT INTO bank.payees (subject_id, iban_hash, iban_enc, iban_last4, bank_code, registered_at, active_from, registered_by) VALUES ($1, $2, $3, $4, 'MEZN', now(), now() + interval '72 hours', 'test')",
        [s, randomBytes(32), randomBytes(48), `000${String(i)}`],
      );
    }
    const res = await web.query("SELECT * FROM bank.web_payees($1)", [subjects[0]]);
    expect(res.fields.map((f) => f.name)).toEqual(["payee_id", "last4", "bank_code", "registered_at", "active_from", "superseded_at"]);
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]).toMatchObject({ last4: "0000", bank_code: "MEZN", superseded_at: null });
    expect((await web.query("SELECT * FROM bank.web_payees(NULL)")).rows).toEqual([]);
  });
});
