import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { Peppers } from "@pt/kyc";
import { SponsorSecrets } from "@pt/property";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../../db/src/migrate.ts";
import { scratchDatabase } from "../../db/test/helpers.ts";
import { committeeClose, committeeVote, offeringTrusteeVote, offeringVote, officer, officerForDuty, propertyRequest, trusteePropertyDecision } from "../../db/test/officers.ts";
import { contiguousMigrations } from "../../property/test/helpers.ts";
import { DEMO_DIR, DEMO_PROPERTIES, DEMO_ROLES, minutesFile, propertyFiles, seedCatalog, SPONSOR, type SeedResult, type SeedSecrets } from "../src/seed.ts";

/**
 * The demo catalog seed (npm run seed:catalog) against scratch databases. The TEST creates the demo
 * officers with the test-only helper (bootstrap admins + stand-in keys); the seed itself never does,
 * and it never votes under an officer's name: it stops at each vote, which the test casts through
 * the portal's own functions with real officer sessions (K4 0016, committee / P8 / platform L3 votes
 * 0026, the trustee's L3 vote 0023), until both offerings are approved.
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

  it("prepares the KYB file, then stops before the K4 request: no request or vote is made under an officer's name", async () => {
    expect(first.properties.map((p) => p.outcome)).toEqual(["waiting", "waiting"]);
    for (const p of first.properties) {
      expect(p.votes).toHaveLength(1);
      expect(p.votes[0]).toMatch(/K4 KYB approval of the demo sponsor .* asks for it in PT Control, Approvals > Property & KYB/);
      expect(p.propertyId).toBeNull();
    }
    expect(first.dutiesGranted).toBe(Object.keys(DEMO_ROLES).length);
    expect(await q("SELECT count(*) FROM property.requests WHERE code = 'K4'")).toBe(0);
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

  it("the compliance maker asks for K4 in the portal (migration 0045); the seed then waits for the decision", async () => {
    const sponsor = (await db.client.query<{ id: string }>("SELECT id::text FROM property.sponsors ORDER BY created_at LIMIT 1")).rows[0]?.id ?? "";
    const r = await propertyRequest(db.client, DEMO_ROLES.complianceMaker.handle, { entity: "sponsor", id: sponsor, code: "K4", reason: "demo catalog: all KYB checks complete and clear" });
    expect(r).toMatchObject({ ok: true });
    const after = done(await seedCatalog(db.pool, { env: {}, secrets: keys }));
    for (const p of after.properties) expect(p.votes[0]).toMatch(/K4 KYB approval .* decides it in PT Control, Approvals > Property & KYB \(\/approvals\/property\/\d+\)/);
    expect(await q("SELECT count(*) FROM property.requests WHERE code = 'K4' AND status = 'open'")).toBe(1);
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
      expect(p.votes.join("\n")).toMatch(/investment committee vote of .* in PT Control, Operations > Investment committee \(\/committees\/\d+\)/);
      expect(p.votes.join("\n")).toMatch(/closing of meeting #\d+ by the chair demo\.ic-1 .*SHA-256 [0-9a-f]{64} \(demo file [a-z0-9-]+-ic-minutes\.txt\)/);
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

  /** The demo property of a property id (by its building and deed number). */
  const demoOf = async (propertyId: string) => {
    const r = (await db.client.query<{ building: string; deed_no: string }>("SELECT building, deed_no FROM property.properties WHERE id = $1", [propertyId])).rows[0];
    const p = DEMO_PROPERTIES.find((x) => x.identifiers.building === r?.building && x.identifiers.deed_no === r.deed_no);
    if (!p) throw new Error(`not a demo property: ${propertyId}`);
    return p;
  };

  it("committee: each member votes and the chair closes in the portal (session, step-up, digest); the seed then stops at P8", async () => {
    const meetings = (await db.client.query<{ id: string; property_id: string }>("SELECT id::text, property_id FROM property.ic_meetings WHERE status = 'open' ORDER BY id")).rows;
    expect(meetings).toHaveLength(2);
    // The database refuses a committee vote under an officer's handle outside the portal (0026 V-2).
    await expect(db.client.query("SELECT property.cast_vote($1, $2, 'approve', NULL)", [meetings[0]?.id, DEMO_ROLES.icMember.handle])).rejects.toMatchObject({ code: "42501" });
    for (const m of meetings) {
      const p = await demoOf(m.property_id);
      // No quorum yet: the chair cannot close.
      expect(await committeeClose(db.client, DEMO_ROLES.icChair.handle, m.id, fileSha(minutesFile(p)))).toMatchObject({ ok: false, state: "23514" });
      for (const member of [DEMO_ROLES.icChair, DEMO_ROLES.icMember, DEMO_ROLES.icIndependent]) {
        expect(await committeeVote(db.client, member.handle, m.id, "approve", "title, encumbrances, two valuations and the opinion are clean")).toMatchObject({ ok: true, status: "approve" });
      }
      // Only the chair closes.
      expect(await committeeClose(db.client, DEMO_ROLES.icMember.handle, m.id, fileSha(minutesFile(p)))).toMatchObject({ ok: false, state: "42501" });
      expect(await committeeClose(db.client, DEMO_ROLES.icChair.handle, m.id, fileSha(minutesFile(p)))).toEqual({ ok: true, status: "legal_approved" });
      const closed = (await db.client.query<{ m: string }>("SELECT encode(minutes_sha256, 'hex') AS m FROM property.ic_meetings WHERE id = $1", [m.id])).rows[0];
      expect(closed?.m).toBe(fileSha(minutesFile(p)));
    }
    const next = done(await seedCatalog(db.pool, { env: {}, secrets: keys }));
    expect(next.properties.map((p) => [p.outcome, p.propertyState])).toEqual([
      ["waiting", "legal_approved"],
      ["waiting", "legal_approved"],
    ]);
    for (const p of next.properties) {
      expect(p.votes).toHaveLength(1);
      expect(p.votes[0]).toMatch(/trustee acceptance \(P8\) .* by demo\.trustee-1: in PT Control, Trustee > Property acceptance \(\/trustee\/properties\/[0-9a-f-]{36}\)/);
    }
    expect(await q("SELECT count(*) FROM admin.audit WHERE action = 'approval.decided' AND detail->>'kind' = 'committee.vote'")).toBe(6);
    expect(await q("SELECT count(*) FROM admin.audit WHERE action = 'approval.decided' AND detail->>'kind' = 'committee.close'")).toBe(2);
    expect(await q("SELECT count(*) FROM property.audit WHERE action = 'ic.vote_reason'")).toBe(6);
  }, 300_000);

  it("P8: the trustee officer accepts in the portal; the seed then creates and submits the offerings and stops at the L3 votes", async () => {
    const waiting = (await db.client.query<{ id: string }>("SELECT id FROM property.properties WHERE state = 'legal_approved' ORDER BY created_at")).rows;
    expect(waiting).toHaveLength(2);
    await expect(
      db.client.query("SELECT property.trustee_decide($1, $2, (SELECT max(id) FROM property.structures WHERE property_id = $1), true, NULL, 'accepted from the command line')", [
        waiting[0]?.id,
        DEMO_ROLES.trustee.handle,
      ]),
    ).rejects.toMatchObject({ code: "42501" });
    for (const p of waiting) {
      expect(await trusteePropertyDecision(db.client, DEMO_ROLES.trustee.handle, p.id, "accept")).toEqual({ ok: true, status: "tokenization_ready" });
    }
    const next = done(await seedCatalog(db.pool, { env: {}, secrets: keys }));
    expect(next.properties.map((p) => [p.outcome, p.propertyState, p.offeringState])).toEqual([
      ["waiting", "tokenization_ready", "pending_approval"],
      ["waiting", "tokenization_ready", "pending_approval"],
    ]);
    for (const p of next.properties) {
      expect(p.votes).toHaveLength(4);
      expect(p.votes.filter((v) => /Operations > Offering approvals \(\/approvals\/offering\/\d+\)/.test(v))).toHaveLength(3);
      expect(p.votes.filter((v) => /Trustee > Co-signing \(\/trustee\/cosign\/offering\/\d+\)/.test(v))).toHaveLength(1);
    }
    expect(await q("SELECT count(*) FROM trustee.audit WHERE action = 'property.accepted'")).toBe(2);
  }, 300_000);

  it("L3: checker, legal head and compliance vote in Offering approvals and the trustee in Co-signing; both offerings reach approved", async () => {
    const requests = (await db.client.query<{ id: string }>("SELECT id::text FROM offering.requests WHERE code = 'L3' AND status = 'open' ORDER BY id")).rows;
    expect(requests).toHaveLength(2);
    for (const r of requests) {
      // The maker who submitted it holds no offering.decide permission (operations maker) and never approves it.
      await expect(offeringVote(db.client, DEMO_ROLES.offeringMaker.handle, r.id, "approve")).rejects.toMatchObject({ code: "42501" });
      // Outside the portal a vote under an officer's handle is refused (0023 binding, kept).
      await expect(db.client.query("SELECT offering.decide($1, $2, true, 'approved from the command line')", [r.id, DEMO_ROLES.offeringChecker.handle])).rejects.toMatchObject({
        code: "42501",
      });
      expect(await offeringVote(db.client, DEMO_ROLES.offeringChecker.handle, r.id, "approve", "terms, price and use of proceeds checked")).toEqual({ ok: true, status: "open" });
      expect(await offeringVote(db.client, DEMO_ROLES.offeringLegalHead.handle, r.id, "approve", "offering documents EN and UR checked")).toEqual({ ok: true, status: "open" });
      // The checker cannot vote twice, not even in another capacity.
      expect(await offeringVote(db.client, DEMO_ROLES.offeringChecker.handle, r.id, "approve")).toMatchObject({ ok: false });
      expect(await offeringVote(db.client, DEMO_ROLES.offeringCompliance.handle, r.id, "approve", "eligibility and risk disclosure checked")).toEqual({ ok: true, status: "open" });
      expect(await offeringTrusteeVote(db.client, DEMO_ROLES.offeringTrustee.handle, r.id, "approve", "trustee approves the offering terms")).toEqual({ ok: true, status: "approved" });
    }
    const next = done(await seedCatalog(db.pool, { env: {}, secrets: keys }));
    expect(next.properties.map((p) => [p.outcome, p.offeringState, p.votes.length, p.writes])).toEqual([
      ["already", "approved", 0, 0],
      ["already", "approved", 0, 0],
    ]);
    expect(await q("SELECT count(*) FROM offering.offerings WHERE state = 'approved'")).toBe(2);
    // Every vote or decision under an officer's handle was taken in the portal and is in the admin audit.
    expect(await officerVotes()).toBe(1 + 6 + 2 + 8);
    expect(await q("SELECT count(*) FROM admin.audit WHERE action = 'approval.decided' AND detail->>'kind' IN ('property', 'committee.vote', 'trustee.property', 'offering', 'trustee.offering')")).toBe(
      1 + 6 + 2 + 8,
    );
    // Idempotent at the end as well.
    const before = await counts(db.client, ["property", "offering", "kyc", "admin", "trustee"]);
    const again = done(await seedCatalog(db.pool, { env: {}, secrets: keys }));
    expect(again.properties.map((p) => [p.outcome, p.writes])).toEqual([
      ["already", 0],
      ["already", 0],
    ]);
    expect(await counts(db.client, ["property", "offering", "kyc", "admin", "trustee"])).toEqual(before);
  }, 300_000);

  it("keeps maker and checker apart and leaves intact property, offering and KYC audit chains", async () => {
    expect(await q("SELECT count(*) FROM property.staff_duties WHERE decided_by IN (requested_by, actor)")).toBe(0);
    expect(await q("SELECT count(*) FROM offering.duties WHERE decided_by IN (requested_by, actor)")).toBe(0);
    expect(await q("SELECT count(*) FROM property.valuers WHERE approved_by = added_by")).toBe(0);
    expect((await db.client.query("SELECT * FROM property.verify_audit()")).rows).toEqual([]);
    expect((await db.client.query("SELECT * FROM offering.verify_audit()")).rows).toEqual([]);
    expect((await db.client.query("SELECT * FROM kyc.verify_audit()")).rows).toEqual([]);
    expect((await db.client.query("SELECT * FROM admin.verify_audit()")).rows).toEqual([]);
    expect((await db.client.query("SELECT * FROM trustee.verify_audit()")).rows).toEqual([]);
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
