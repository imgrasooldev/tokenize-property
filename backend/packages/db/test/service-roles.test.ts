import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { serviceRole, serviceRoles, type ServiceName } from "@pt/config";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../src/migrate.ts";
import { ensureServiceRoles } from "../src/service-roles.ts";
import { adminSettings, contiguousMigrations, scratchDatabase, serviceLogin } from "./helpers.ts";

/**
 * T-012 (migration 0029, ADR 0016): every backend service has its own group role. For each one:
 * the exact privilege inventory (reviewed text file next to this test: any migration that widens a
 * service role changes it), what its code runs works, and everything else is refused with 42501.
 * The services' own suites also run under these roles (see the `serviceLogin` users in
 * indexer, outbox, kyc, bank, anchor, recon, recovery, tax, notify and signer tests).
 */
const SERVICES = serviceRoles().map(([s]) => s);
let admin: pg.Client;
let settings: pg.ClientConfig;
let drop: () => Promise<void>;
const logins = new Map<ServiceName, { client: pg.Client; drop: () => Promise<void> }>();

beforeAll(async () => {
  ({ client: admin, settings, drop } = await scratchDatabase());
  await migrate(admin, contiguousMigrations());
  for (const s of SERVICES) {
    const l = await serviceLogin(s, String(settings.database));
    const client = new pg.Client(l.settings);
    await client.connect();
    logins.set(s, { client, drop: l.drop });
  }
}, 180_000);

afterAll(async () => {
  for (const l of logins.values()) await l.client.end();
  await drop();
  for (const l of logins.values()) await l.drop();
});

const as = (s: ServiceName): pg.Client => {
  const l = logins.get(s);
  if (!l) throw new Error(`no login for ${s}`);
  return l.client;
};

/** The statement must fail with insufficient_privilege (42501), not merely with some error. */
async function denied(s: ServiceName, sql: string): Promise<void> {
  await expect(as(s).query(sql), `${s}: ${sql}`).rejects.toMatchObject({ code: "42501" });
}

/** Everything `role` may do in the application schemas, one line per object, sorted. */
async function inventory(role: string): Promise<string> {
  const q = (sql: string) => admin.query<{ line: string }>(sql, [role]).then((r) => r.rows.map((x) => x.line));
  const schemas = `n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast') AND n.nspname NOT LIKE 'pg_temp%' AND n.nspname NOT LIKE 'pg_toast_temp%'`;
  const lines = [
    ...(await q(`SELECT 'schema ' || n.nspname || ': USAGE' AS line FROM pg_namespace n WHERE ${schemas} AND has_schema_privilege($1, n.oid, 'USAGE')`)),
    ...(await q(`SELECT 'schema ' || n.nspname || ': CREATE' AS line FROM pg_namespace n WHERE ${schemas} AND has_schema_privilege($1, n.oid, 'CREATE')`)),
    ...(await q(`
      SELECT CASE c.relkind WHEN 'S' THEN 'sequence ' WHEN 'v' THEN 'view ' WHEN 'm' THEN 'view ' ELSE 'table ' END
             || n.nspname || '.' || c.relname || ': ' || string_agg(p.priv, ', ' ORDER BY p.priv) AS line
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN LATERAL (
        SELECT priv FROM unnest(CASE WHEN c.relkind = 'S' THEN ARRAY['USAGE', 'SELECT', 'UPDATE']
                                     ELSE ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] END) AS priv
        WHERE CASE WHEN c.relkind = 'S' THEN has_sequence_privilege($1, c.oid, priv) ELSE has_table_privilege($1, c.oid, priv) END
        UNION
        SELECT priv || ' (some columns)' FROM unnest(ARRAY['SELECT', 'INSERT', 'UPDATE']) AS priv
        WHERE c.relkind <> 'S' AND NOT has_table_privilege($1, c.oid, priv) AND has_any_column_privilege($1, c.oid, priv)
      ) p
      WHERE ${schemas} AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f') AND has_schema_privilege($1, n.oid, 'USAGE')
      GROUP BY c.relkind, n.nspname, c.relname`)),
    ...(await q(`
      SELECT 'function ' || n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS line
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE ${schemas} AND p.prokind IN ('f', 'p') AND has_schema_privilege($1, n.oid, 'USAGE') AND has_function_privilege($1, p.oid, 'EXECUTE')`)),
  ];
  return `${lines.sort().join("\n")}\n`;
}

describe("service group roles (migration 0029)", () => {
  it("are NOLOGIN, without any special right, and members only of the roles listed in the migration", async () => {
    const { rows } = await admin.query<{ rolname: string; ok: boolean; member_of: string[] | null }>(
      `SELECT r.rolname, NOT (r.rolcanlogin OR r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls) AS ok,
              (SELECT array_agg(g.rolname::text ORDER BY g.rolname) FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid
               WHERE m.member = r.oid) AS member_of
       FROM pg_roles r WHERE r.rolname LIKE 'pt\\_svc\\_%' ORDER BY r.rolname`);
    expect(rows.map((r) => r.rolname)).toEqual(SERVICES.map((s) => serviceRole(s).group).sort());
    expect(rows.every((r) => r.ok)).toBe(true);
    const sql = readFileSync(fileURLToPath(new URL("../migrations/0029_service_roles.sql", import.meta.url)), "utf8");
    for (const r of rows) {
      // Every membership is spelled out in a GRANT ... TO <group> line of the migration.
      const grants = sql.split("\n").filter((l) => l.startsWith("GRANT ") && l.endsWith(` TO ${r.rolname} WITH INHERIT TRUE, SET FALSE;`));
      const listed = grants.flatMap((l) => l.slice(6, l.indexOf(" TO ")).split(",").map((x) => x.trim()));
      for (const m of r.member_of ?? []) expect(listed, `${r.rolname} member of ${m}`).toContain(m);
    }
  });

  it("can never SET ROLE to their group or to a member role", async () => {
    for (const s of SERVICES) {
      await expect(as(s).query(`SET ROLE ${serviceRole(s).group}`), s).rejects.toMatchObject({ code: "42501" });
    }
    await expect(as("signer").query("SET ROLE pt_signer"), "signer").rejects.toMatchObject({ code: "42501" });
    await expect(as("indexer").query("SET ROLE pt_chain_writer"), "indexer").rejects.toMatchObject({ code: "42501" });
  });

  it.each(SERVICES)("%s: privilege inventory matches the reviewed list", async (s) => {
    await expect(await inventory(serviceRole(s).group)).toMatchFileSnapshot(`./service-roles/${s}.txt`);
  });

  it.each(SERVICES)("%s: cannot create objects, roles or databases, or touch the migration record", async (s) => {
    for (const sql of [
      "CREATE TABLE public.svc_should_not_exist (id int)",
      "CREATE SCHEMA svc_should_not_exist",
      "CREATE ROLE svc_should_not_exist",
      "CREATE DATABASE svc_should_not_exist",
      "SELECT * FROM public.schema_migrations",
      "DELETE FROM public.schema_migrations",
    ]) {
      await expect(as(s).query(sql), `${s}: ${sql}`).rejects.toMatchObject({ code: "42501" });
    }
  });
});

describe("what each service may not do (42501)", () => {
  const forbidden: Record<ServiceName, string[]> = {
    indexer: [
      "SELECT chain.clear_halt('x', 'indexer', 'not the indexer')",
      "UPDATE chain.holdings SET balance = 0",
      "SELECT * FROM ledger.journal",
      "SELECT outbox.enqueue('x', 'issuance.mint', '{}'::jsonb, NULL, 'indexer')",
      "SELECT * FROM signer.requests",
      "SELECT * FROM kyc.status",
    ],
    signer: [
      "SELECT signer.decide('00000000-0000-0000-0000-000000000000', 'signer', 'approve', 'self approval')",
      "SELECT signer.propose_policy('issuance.mint', '{}'::jsonb, 'signer')",
      "DELETE FROM signer.requests",
      "UPDATE signer.policies SET rule = '{}'::jsonb",
      "SELECT * FROM outbox.claim('signer', 1, 30)",
      "SELECT ledger.post_journal('x', 'x', NULL, NULL, 'signer', '[]'::jsonb)",
      "SELECT * FROM kyc.status",
      "SELECT * FROM bank.payees",
      "SELECT * FROM webdemo.investors",
    ],
    outbox: [
      "SELECT outbox.enqueue('x', 'issuance.mint', '{}'::jsonb, NULL, 'outbox')",
      "SELECT outbox.operator_decide(1, 'outbox', 'confirm', 'not an operator')",
      "UPDATE outbox.commands SET status = 'confirmed'",
      "SELECT * FROM signer.requests",
      "SELECT * FROM ledger.journal",
      "SELECT * FROM kyc.status",
    ],
    kyc: [
      "SELECT kyc.revoke('00000000-0000-0000-0000-000000000000', 'kyc', 'officers only')",
      "SELECT kyc.decide_clearance(1, 'kyc', 'approve', 'officers only')",
      "SELECT * FROM kyc.checks",
      "SELECT * FROM kyc.subjects",
      "SELECT outbox.enqueue('x', 'compliance.freeze', '{}'::jsonb, NULL, 'kyc')",
      "SELECT * FROM signer.requests",
      "SELECT * FROM bank.payees",
    ],
    offboarding: [
      "SELECT * FROM kyc.status",
      "SELECT kyc.is_verified('0x00000000000000000000000000000000000000aa')",
      "SELECT outbox.enqueue('x', 'compliance.freeze', '{}'::jsonb, NULL, 'offboarding')",
      "SELECT * FROM outbox.commands",
    ],
    bank: [
      "SELECT bank.decide_payout_batch(1, 'bank', 'approve', 'operators only')",
      "SELECT bank.return_credit('x', 'bank', 'operators only')",
      "SELECT * FROM bank.payees",
      "UPDATE bank.payout_batches SET status = 'approved'",
      "SELECT * FROM kyc.subjects",
      "SELECT ledger.post_journal('x', 'x', NULL, NULL, 'bank', '[]'::jsonb)",
      "SELECT * FROM signer.requests",
    ],
    anchor: [
      "UPDATE anchor.anchors SET status = 'confirmed'",
      "DELETE FROM anchor.anchors",
      "SELECT ledger.post_journal('x', 'x', NULL, NULL, 'anchor', '[]'::jsonb)",
      "SELECT * FROM signer.requests",
      "SELECT * FROM kyc.status",
    ],
    recon: [
      "SELECT recon.decide_unfreeze(1, 'recon', 'approve', 'operators only')",
      "SELECT ledger.post_journal('x', 'x', NULL, NULL, 'recon', '[]'::jsonb)",
      "UPDATE chain.holdings SET balance = 0",
      "SELECT outbox.enqueue('x', 'issuance.mint', '{}'::jsonb, NULL, 'recon')",
      "SELECT * FROM kyc.subjects",
      "SELECT * FROM bank.payees",
    ],
    recovery: [
      "SELECT * FROM kyc.subjects",
      "SELECT outbox.enqueue('x', 'recovery.freeze', '{}'::jsonb, NULL, 'recovery')",
      "SELECT ledger.post_journal('x', 'x', NULL, NULL, 'recovery', '[]'::jsonb)",
      "SELECT * FROM signer.requests",
    ],
    tax: [
      "SELECT * FROM kyc.subjects",
      "SELECT ledger.post_journal('x', 'x', NULL, NULL, 'tax', '[]'::jsonb)",
      "SELECT * FROM signer.requests",
      "SELECT * FROM bank.payees",
    ],
    notify: [
      "SELECT notify.operator_decide(1, 'notify', 'retry', 'operators only')",
      "SELECT * FROM kyc.subjects",
      "SELECT * FROM signer.requests",
      "SELECT ledger.post_journal('x', 'x', NULL, NULL, 'notify', '[]'::jsonb)",
    ],
    exit: [
      "SELECT * FROM exit.cases",
      "SELECT * FROM exit.audit",
      "SELECT * FROM exit.verify_audit()",
      "SELECT exit.decide_final(1, 'exit', 'approve', 'checkers only')",
      "SELECT outbox.enqueue('x', 'issuance.burn', '{}'::jsonb, NULL, 'exit')",
      "SELECT ledger.post_journal('x', 'x', NULL, NULL, 'exit', '[]'::jsonb)",
    ],
    transfer: [
      "SELECT * FROM transfer.audit",
      "SELECT * FROM transfer.verify_audit()",
      "SELECT transfer.command_allowed('transfer.execute', '{}'::jsonb)",
      "SELECT outbox.enqueue('x', 'transfer.execute', '{}'::jsonb, NULL, 'transfer')",
      "SELECT * FROM kyc.subjects",
      "SELECT * FROM signer.requests",
    ],
    audit: [
      "UPDATE signer.requests SET status = 'signed'",
      "SELECT signer.decide('00000000-0000-0000-0000-000000000000', 'audit', 'approve', 'read only')",
      "SELECT kyc.revoke('00000000-0000-0000-0000-000000000000', 'audit', 'read only')",
      "SELECT * FROM bank.payees",
      "SELECT ledger.post_journal('x', 'x', NULL, NULL, 'audit', '[]'::jsonb)",
      "SELECT outbox.enqueue('x', 'issuance.mint', '{}'::jsonb, NULL, 'audit')",
    ],
    console: [
      "SELECT * FROM chain.holdings",
      "UPDATE ledger.postings SET amount = 0",
      "ALTER TABLE ledger.postings DISABLE TRIGGER ALL",
      "SELECT * FROM webdemo.investors",
      "SELECT * FROM kyc.status",
      "SELECT * FROM signer.requests",
    ],
  };
  it.each(SERVICES)("%s", async (s) => {
    for (const sql of new Map(Object.entries(forbidden)).get(s) ?? []) await denied(s, sql);
  });
});

describe("db:service-roles (ensureServiceRoles)", () => {
  it("creates one login per service in its group only, keeps it idempotent and removes extra memberships", async () => {
    const tag = randomBytes(3).toString("hex");
    const creds = new Map(SERVICES.map((s) => [s, { user: `${serviceRole(s).login}_e${tag}`, password: randomBytes(24).toString("base64url") }]));
    const cred = (s: ServiceName): { user: string; password: string } => creds.get(s) ?? { user: "missing", password: "missing" };
    const root = new pg.Client(adminSettings(String(settings.database)));
    await root.connect();
    try {
      const first = await ensureServiceRoles(root, creds);
      expect(first.every((r) => r.created)).toBe(true);
      // A stray membership (e.g. granted by hand) is removed on the next run.
      await root.query(`GRANT pt_ledger_writer TO ${cred("indexer").user}`);
      const again = await ensureServiceRoles(root, creds);
      expect(again.some((r) => r.created)).toBe(false);
      const { rows } = await root.query<{ u: string; groups: string[]; ok: boolean }>(
        `SELECT u.rolname AS u, array_agg(g.rolname::text) AS groups,
                bool_and(u.rolcanlogin AND NOT (u.rolsuper OR u.rolcreatedb OR u.rolcreaterole OR u.rolreplication OR u.rolbypassrls)) AS ok
         FROM pg_roles u JOIN pg_auth_members m ON m.member = u.oid JOIN pg_roles g ON g.oid = m.roleid
         WHERE u.rolname LIKE $1 GROUP BY u.rolname`, [`%\\_e${tag}`]);
      expect(rows).toHaveLength(SERVICES.length);
      for (const s of SERVICES) expect(rows.find((r) => r.u === cred(s).user)).toMatchObject({ groups: [serviceRole(s).group], ok: true });
      // The login works with its password and is limited to its group.
      const c = new pg.Client({ ...settings, user: cred("recovery").user, password: cred("recovery").password });
      await c.connect();
      try {
        await expect(c.query("SELECT * FROM ledger.journal")).rejects.toMatchObject({ code: "42501" });
      } finally {
        await c.end();
      }
    } finally {
      for (const s of SERVICES) await root.query(`DROP ROLE IF EXISTS ${cred(s).user}`);
      await root.end();
    }
  });
});
