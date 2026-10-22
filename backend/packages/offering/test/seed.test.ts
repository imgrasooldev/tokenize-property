import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { Peppers } from "@pt/kyc";
import { SponsorSecrets } from "@pt/property";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../../db/src/migrate.ts";
import { scratchDatabase } from "../../db/test/helpers.ts";
import { officer, officerForDuty } from "../../db/test/officers.ts";
import { contiguousMigrations } from "../../property/test/helpers.ts";
import { DEMO_DIR, DEMO_PROPERTIES, DEMO_ROLES, propertyFiles, seedCatalog, SPONSOR, type SeedResult, type SeedSecrets } from "../src/seed.ts";

/**
 * The demo catalog seed (npm run seed:catalog) against scratch databases. The TEST creates the demo
 * officers with the test-only helper (bootstrap admins + stand-in keys); the seed itself never does,
 * and it never votes under an officer's name: it stops at each vote, which the test casts through
 * the portal's own function with a real officer session where PT Control has a screen for it.
 */

const fileSha = (name: string): string => createHash("sha256").update(readFileSync(`${DEMO_DIR}${name}`)).digest("hex");

const secrets = (): SeedSecrets => ({
  sponsor: new SponsorSecrets(Peppers.of([{ version: 1, key: randomBytes(32) }]), randomBytes(32)),
  kycPeppers: Peppers.of([{ version: 1, key: randomBytes(32) }]),
  kycDataKey: randomBytes(32),
});

interface Db {
  client: pg.Client;
  pool: pg.Pool;
  drop: () => Promise<void>;
}

async function database(): Promise<Db> {
  const s = await scratchDatabase();
  await migrate(s.client, contiguousMigrations());
  const pool = new pg.Pool({ ...s.settings, max: 4 });
  return {
    client: s.client,
    pool,
    drop: async () => {
      await pool.end();
      await s.drop();
    },
  };
}

/** Exact row counts of every table in the given schemas. */
async function counts(client: pg.Client, schemas: string[]): Promise<Record<string, number>> {
  const { rows } = await client.query<{ t: string }>(
    "SELECT table_schema || '.' || table_name AS t FROM information_schema.tables WHERE table_schema = ANY ($1) AND table_type = 'BASE TABLE' ORDER BY 1",
    [schemas],
  );
  const out = new Map<string, number>();
  for (const { t } of rows) {
    const [schema, table] = t.split(".");
    const r = await client.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${client.escapeIdentifier(schema ?? "")}.${client.escapeIdentifier(table ?? "")}`);
    out.set(t, Number(r.rows[0]?.n ?? "0"));
  }
  return Object.fromEntries(out);
}

const done = (r: SeedResult): Extract<SeedResult, { status: "done" }> => {
  if (r.status !== "done") throw new Error(`seed ${r.status}: ${JSON.stringify(r)}`);
  return r;
};

describe("seed:catalog with the demo officers enrolled", () => {
  let db: Db;
  const keys = secrets();
  let first: Extract<SeedResult, { status: "done" }>;
  const q = async (sql: string, params: unknown[] = []): Promise<number> =>
    Number((await db.client.query<{ n: string }>(sql.replace("SELECT count(*)", "SELECT count(*) AS n"), params)).rows[0]?.n ?? "-1");

  beforeAll(async () => {
    db = await database();
    for (const d of Object.values(DEMO_ROLES)) {
      if (d.schema === "property") await officerForDuty(db.client, d.handle, d.duty);
    }
    await officer(db.client, DEMO_ROLES.offeringMaker.handle, "ops_maker");
    await officer(db.client, DEMO_ROLES.offeringChecker.handle, "ops_checker");
    first = done(await seedCatalog(db.pool, { env: {}, secrets: keys }));
  }, 300_000);
  afterAll(async () => {
    await db.drop();
  }, 120_000);

  /** Every vote or decision recorded under a portal officer's handle. */
  const officerVotes = async (): Promise<number> =>
    (await q("SELECT count(*) FROM property.requests r JOIN admin.officers o ON o.handle = r.decided_by")) +
    (await q("SELECT count(*) FROM property.ic_votes v JOIN admin.officers o ON o.handle = v.member")) +
    (await q("SELECT count(*) FROM property.trustee_decisions d JOIN admin.officers o ON o.handle = d.trustee")) +
    (await q("SELECT count(*) FROM offering.request_votes v JOIN admin.officers o ON o.handle = v.officer"));

  it("prepares the KYB file, then stops at the K4 decision: no vote is cast under an officer's name", async () => {
    expect(first.properties.map((p) => p.outcome)).toEqual(["waiting", "waiting"]);
    for (const p of first.properties) {
      expect(p.votes).toHaveLength(1);
      expect(p.votes[0]).toMatch(/K4 KYB approval .* decides it in PT Control, Approvals > Property & KYB \(\/approvals\/property\/\d+\)/);
      expect(p.propertyId).toBeNull();
    }
    expect(first.dutiesGranted).toBe(Object.keys(DEMO_ROLES).length);
    expect(await q("SELECT count(*) FROM property.requests WHERE code = 'K4' AND status = 'open'")).toBe(1);
    expect(await officerVotes()).toBe(0);
  });

  it("writes nothing on a second run while the same votes are due", async () => {
    const before = await counts(db.client, ["property", "offering", "kyc", "admin"]);
    const again = done(await seedCatalog(db.pool, { env: {}, secrets: keys }));
    expect(again.dutiesGranted).toBe(0);
    expect(again.properties.map((p) => [p.outcome, p.writes])).toEqual([
      ["waiting", 0],
      ["waiting", 0],
    ]);
    expect(again.properties.map((p) => p.votes)).toEqual(first.properties.map((p) => p.votes));
    expect(await counts(db.client, ["property", "offering", "kyc", "admin"])).toEqual(before);
  });

  it("continues once the compliance officer decided K4 in the portal (session, step-up, digest), and stops at the committee votes", async () => {
    const k4 = (await db.client.query<{ id: string; requested_by: string }>("SELECT id::text, requested_by FROM property.requests WHERE code = 'K4' AND status = 'open'")).rows[0];
    const checker = k4?.requested_by === DEMO_ROLES.complianceChecker.handle ? DEMO_ROLES.complianceMaker.handle : DEMO_ROLES.complianceChecker.handle;
    const o = await officer(db.client, checker, "compliance_officer");
    const digest = (await db.client.query<{ d: Buffer }>("SELECT admin.property_request_digest($1) AS d", [k4?.id])).rows[0]?.d;
    const r = await db.client.query<{ r: { ok: boolean; status?: string; error?: string } }>(
      "SELECT admin.decide_property_request($1, $2, 'approve', 'KYB file reviewed in PT Control, agree', $3) AS r",
      [o.sessionHash, k4?.id, digest],
    );
    expect(r.rows[0]?.r).toMatchObject({ ok: true });
    const next = done(await seedCatalog(db.pool, { env: {}, secrets: keys }));
    expect(next.properties.map((p) => p.outcome)).toEqual(["waiting", "waiting"]);
    for (const p of next.properties) {
      expect(p.propertyState).toBe("under_review");
      expect(p.votes.join("\n")).toMatch(/investment committee vote of /);
      expect(p.votes.join("\n")).toMatch(/no PT Control screen for this vote yet/);
    }
    // The only decision under an officer's name is the one taken in the portal.
    expect(await officerVotes()).toBe(1);
    expect(await q("SELECT count(*) FROM admin.audit WHERE action = 'approval.decided' AND detail->>'kind' = 'property'")).toBe(1);
    expect(await q("SELECT count(*) FROM property.requests WHERE status = 'approved' AND decided_by = requested_by")).toBe(0);
    // Idempotent at this stop as well.
    const again = done(await seedCatalog(db.pool, { env: {}, secrets: keys }));
    expect(again.properties.map((p) => [p.outcome, p.writes])).toEqual([
      ["waiting", 0],
      ["waiting", 0],
    ]);
  });

  it("keeps maker and checker apart and leaves intact property, offering and KYC audit chains", async () => {
    expect(await q("SELECT count(*) FROM property.staff_duties WHERE decided_by IN (requested_by, actor)")).toBe(0);
    expect(await q("SELECT count(*) FROM offering.duties WHERE decided_by IN (requested_by, actor)")).toBe(0);
    expect(await q("SELECT count(*) FROM property.valuers WHERE approved_by = added_by")).toBe(0);
    expect((await db.client.query("SELECT * FROM property.verify_audit()")).rows).toEqual([]);
    expect((await db.client.query("SELECT * FROM offering.verify_audit()")).rows).toEqual([]);
    expect((await db.client.query("SELECT * FROM kyc.verify_audit()")).rows).toEqual([]);
    expect((await db.client.query("SELECT * FROM admin.verify_audit()")).rows).toEqual([]);
  });

  it("records the SHA-256 of the demo files' exact bytes", async () => {
    const { rows: kyb } = await db.client.query<{ sha256: string }>("SELECT sha256 FROM property.document_list WHERE property_id IS NULL ORDER BY sha256");
    expect(kyb.map((r) => r.sha256)).toEqual(SPONSOR.docs.map(([, f]) => fileSha(f)).sort());
    for (const p of DEMO_PROPERTIES) {
      const { rows } = await db.client.query<{ doc_type: string; sha256: string }>(
        "SELECT d.doc_type, d.sha256 FROM property.document_list d JOIN property.properties x ON x.id = d.property_id WHERE x.building = $1 AND x.deed_no = $2",
        [p.identifiers.building, p.identifiers.deed_no],
      );
      expect(rows.length).toBeGreaterThan(0);
      const expected = new Set(propertyFiles(p).map((f) => `${f.docType}:${fileSha(f.file)}`));
      for (const r of rows) expect(expected.has(`${r.doc_type}:${r.sha256}`)).toBe(true);
    }
  });

  it("is refused in production and outside local/demo databases", async () => {
    const r = await seedCatalog(db.pool, { env: { NODE_ENV: "production" }, secrets: keys });
    expect(r.status).toBe("refused");
    if (r.status === "refused") expect(r.reason).toContain("NODE_ENV=production");
  });
});

describe("seed:catalog without officers", () => {
  let db: Db;
  beforeAll(async () => {
    db = await database();
  }, 180_000);
  afterAll(async () => {
    await db.drop();
  }, 120_000);

  it("skips with an enrolment plan and writes nothing (no bootstrap, no officers)", async () => {
    const schemas = ["property", "offering", "admin", "kyc"];
    const before = await counts(db.client, schemas);
    const r = await seedCatalog(db.pool, { env: {}, secrets: secrets() });
    expect(r.status).toBe("skipped");
    if (r.status !== "skipped") return;
    const handles = new Set(Object.values(DEMO_ROLES).map((d) => d.handle));
    expect(r.plan).toHaveLength(handles.size);
    for (const h of handles) expect(r.plan.join("\n")).toContain(`enrol ${h} with role`);
    expect(await counts(db.client, schemas)).toEqual(before);
    expect(before["admin.officers"]).toBe(0);
  });

  it("skips when the secrets are missing", async () => {
    const r = await seedCatalog(db.pool, { env: {} });
    expect(r.status).toBe("skipped");
    if (r.status === "skipped") expect(r.problems.join("\n")).toContain("secrets:");
  });

  it("is refused with NODE_ENV=production before touching the database", async () => {
    const r = await seedCatalog(db.pool, { env: { NODE_ENV: "production" } });
    expect(r.status).toBe("refused");
  });
});
