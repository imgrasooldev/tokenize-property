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
import { DEMO_DIR, DEMO_PROPERTIES, DEMO_ROLES, offeringFiles, propertyFiles, seedCatalog, SPONSOR, type SeedResult, type SeedSecrets } from "../src/seed.ts";

/**
 * The demo catalog seed (npm run seed:catalog) against scratch databases. The TEST creates the demo
 * officers with the test-only helper (bootstrap admins + stand-in keys); the seed itself never does.
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

  it("onboards both properties to Tokenization Ready and their offerings to approved", async () => {
    expect(first.properties.map((p) => p.outcome)).toEqual(["created", "created"]);
    for (const p of first.properties) {
      expect(p.line).toContain("created");
      const { rows } = await db.client.query<{ state: string; offering: string }>(
        "SELECT p.state, o.state AS offering FROM property.properties p JOIN offering.offerings o ON o.property_id = p.id WHERE p.id = $1",
        [p.propertyId],
      );
      expect(rows).toEqual([{ state: "tokenization_ready", offering: "approved" }]);
    }
    expect(first.dutiesGranted).toBe(Object.keys(DEMO_ROLES).length);
  });

  it("keeps maker and checker apart everywhere", async () => {
    const q = async (sql: string): Promise<number> => Number((await db.client.query<{ n: string }>(sql.replace("SELECT count(*)", "SELECT count(*) AS n"))).rows[0]?.n ?? "-1");
    expect(await q("SELECT count(*) FROM property.requests WHERE status = 'approved' AND decided_by = requested_by")).toBe(0);
    expect(await q("SELECT count(*) FROM property.requests WHERE status = 'approved'")).toBe(1);
    expect(await q("SELECT count(*) FROM property.staff_duties WHERE decided_by IN (requested_by, actor)")).toBe(0);
    expect(await q("SELECT count(*) FROM offering.duties WHERE decided_by IN (requested_by, actor)")).toBe(0);
    expect(await q("SELECT count(*) FROM property.valuers WHERE approved_by = added_by")).toBe(0);
    expect(await q("SELECT count(*) FROM offering.request_votes v JOIN offering.requests r ON r.id = v.request_id WHERE v.officer = r.requested_by")).toBe(0);
    // L3: four distinct approvers per offering, none of them a party to the property's S-01 file.
    const { rows } = await db.client.query<{ n: number; parties: number }>(
      `SELECT count(DISTINCT v.officer)::int AS n,
              count(*) FILTER (WHERE v.officer = ANY (property.parties(o.property_id)))::int AS parties
       FROM offering.request_votes v JOIN offering.requests r ON r.id = v.request_id AND r.code = 'L3'
       JOIN offering.offerings o ON o.id = r.offering_id GROUP BY o.id`,
    );
    expect(rows).toEqual([
      { n: 4, parties: 0 },
      { n: 4, parties: 0 },
    ]);
  });

  it("leaves intact property and offering audit chains", async () => {
    expect((await db.client.query("SELECT * FROM property.verify_audit()")).rows).toEqual([]);
    expect((await db.client.query("SELECT * FROM offering.verify_audit()")).rows).toEqual([]);
    expect((await db.client.query("SELECT * FROM kyc.verify_audit()")).rows).toEqual([]);
  });

  it("records the SHA-256 of the demo files' exact bytes", async () => {
    const { rows: kyb } = await db.client.query<{ sha256: string }>("SELECT sha256 FROM property.document_list WHERE property_id IS NULL ORDER BY sha256");
    expect(kyb.map((r) => r.sha256)).toEqual(SPONSOR.docs.map(([, f]) => fileSha(f)).sort());
    for (const [i, p] of DEMO_PROPERTIES.entries()) {
      const id = first.properties.at(i)?.propertyId;
      const { rows } = await db.client.query<{ doc_type: string; sha256: string }>("SELECT doc_type, sha256 FROM property.document_list WHERE property_id = $1", [id]);
      const recorded = rows.map((r) => `${r.doc_type}:${r.sha256}`).sort();
      expect(recorded).toEqual(propertyFiles(p).map((f) => `${f.docType}:${fileSha(f.file)}`).sort());
      const f = offeringFiles(p);
      const { rows: o } = await db.client.query<{ en: string; ur: string; risk: string }>(
        "SELECT encode(doc_en_sha, 'hex') AS en, encode(doc_ur_sha, 'hex') AS ur, encode(risk_sha, 'hex') AS risk FROM offering.offerings WHERE property_id = $1",
        [id],
      );
      expect(o).toEqual([{ en: fileSha(f.en), ur: fileSha(f.ur), risk: fileSha(f.risk) }]);
    }
  });

  it("writes nothing on a second run and reports already approved", async () => {
    const before = await counts(db.client, ["property", "offering", "kyc", "admin"]);
    const again = done(await seedCatalog(db.pool, { env: {}, secrets: keys }));
    expect(again.dutiesGranted).toBe(0);
    expect(again.properties.map((p) => [p.outcome, p.writes])).toEqual([
      ["already", 0],
      ["already", 0],
    ]);
    for (const p of again.properties) expect(p.line).toMatch(/: already approved$/);
    expect(await counts(db.client, ["property", "offering", "kyc", "admin"])).toEqual(before);
  });

  it("lets the database refuse mark_ready for a token that is not in the read model", async () => {
    const r = done(await seedCatalog(db.pool, { env: {}, secrets: keys, token: `0x${"ab".repeat(20)}` }));
    for (const p of r.properties) {
      expect(p.offeringState).toBe("approved");
      expect(p.line).toContain("mark_ready refused: the token is not in the read model");
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
