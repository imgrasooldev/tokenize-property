import { randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../../db/src/migrate.ts";
import { contiguousMigrations, scratchDatabase, serviceLogin } from "../../db/test/helpers.ts";
import { officer, type TestOfficer } from "../../db/test/officers.ts";
import { Peppers } from "../src/crypto.ts";
import { MockSanctions, mockProviders } from "../src/providers.ts";
import { RescreenWorker } from "../src/rescreen.ts";
import { KycService, statusOf, subjectStatus } from "../src/service.ts";

/**
 * Step 6c (migration 0019, ADR 0011 section 11): KYC review cases against a real PostgreSQL, driven
 * the way the compliance portal drives them (admin.* functions with officer sessions). Screening
 * matches open cases by themselves; high risk needs two different compliance officers (in SQL);
 * a PEP is accepted only after enhanced due diligence by two officers; a list hit is final; free
 * text never carries a CNIC; officer names are bound to sessions; re-screening runs in the KYC
 * service; the compliance audit chain verifies and finds rows written around it.
 */
let db: pg.Client;
let portal: pg.Client;
let pool: pg.Pool;
let drop: () => Promise<void>;
let kyc: KycService;
let compA: TestOfficer;
let compB: TestOfficer;
let opsChecker: TestOfficer;
let seq = 5000;
const peppers = Peppers.of([{ version: 1, key: randomBytes(32) }]);
const kycDataKey = randomBytes(32);
const cnic = (last = 1): string => `35202-${String(1_000_000 + ++seq).slice(-7)}-${String(last)}`;
const wallet = (): string => `0x${randomBytes(20).toString("hex")}`;
const liveness = (): string => `sess-comp-${String(++seq).padStart(6, "0")}`;

beforeAll(async () => {
  let settings: pg.ClientConfig;
  ({ client: db, settings, drop } = await scratchDatabase());
  await migrate(db, contiguousMigrations());
  pool = new pg.Pool({ ...settings, max: 6 });
  portal = new pg.Client(settings);
  await portal.connect();
  // Exactly the rights of the portal's login (member of pt_admin_portal only).
  await portal.query("SET ROLE pt_admin_portal");
  kyc = new KycService(pool, mockProviders(), peppers, kycDataKey);
  compA = await officer(db, "comp.amna", "compliance_officer");
  compB = await officer(db, "comp.bilal", "compliance_officer");
  opsChecker = await officer(db, "ops.checker.c", "ops_checker");
}, 180_000);

afterAll(async () => {
  await portal.end();
  await pool.end();
  await drop();
}, 180_000);

async function pgCode(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
    return undefined;
  } catch (e) {
    return (e as { code?: string }).code;
  }
}

interface Case {
  id: number;
  kind: string;
  risk: string;
  flags: string[];
  status: string;
  digest: string;
  subject: { status: string; cnic: string };
  blockers: { approve: string[]; confirm: string[] };
}

async function kycCase(o: TestOfficer, id: number): Promise<Case> {
  const { rows } = await portal.query<{ v: Case }>("SELECT admin.kyc_case($1, $2) AS v", [o.sessionHash, id]);
  if (!rows[0]?.v) throw new Error(`no case ${String(id)}`);
  return rows[0].v;
}

async function act(o: TestOfficer, id: number, action: string, reason = "reviewed the screening evidence in full"): Promise<{ ok: boolean; status?: string; error?: string }> {
  const c = await kycCase(o, id);
  const { rows } = await portal.query<{ r: { ok: boolean; status?: string; error?: string } }>("SELECT admin.kyc_case_act($1, $2, $3, $4, $5) AS r", [
    o.sessionHash,
    id,
    action,
    reason,
    Buffer.from(c.digest, "hex"),
  ]);
  return rows[0]?.r ?? { ok: false };
}

async function caseOf(subjectId: string): Promise<number> {
  const { rows } = await db.query<{ id: string }>("SELECT id FROM compliance.kyc_cases WHERE subject_id = $1 ORDER BY id DESC LIMIT 1", [subjectId]);
  return Number(rows[0]?.id ?? 0);
}

async function verifiedInvestor(name = "Hina Verified"): Promise<{ subjectId: string; wallet: string }> {
  const w = wallet();
  const r = await kyc.onboard({ cnic: cnic(), fullName: name, livenessSessionId: liveness(), wallet: w });
  expect(r.status).toBe("verified");
  return { subjectId: r.subjectId, wallet: w };
}

describe("mock screening (PEP list)", () => {
  it("a sanctions match takes precedence; a fictional PEP is a review with reason pep_match; others pass", async () => {
    const s = new MockSanctions();
    expect(await s.screen({ fullName: "Zargham Testkhan" })).toMatchObject({ outcome: "fail", reason: "list_hit" });
    expect(await s.screen({ fullName: "Pervaiz Peptest" })).toMatchObject({ outcome: "review", reason: "pep_match", score: 100, listVersion: "mock-pep-2026-10-01" });
    expect(await s.screen({ fullName: "Ayesha Siddiqui" })).toMatchObject({ outcome: "pass", reason: "clear" });
  });
});

describe("KYC review cases (C-1, C-2)", () => {
  it("a possible sanctions match opens a high-risk case by itself; two different officers clear it", async () => {
    const r = await kyc.onboard({ cnic: cnic(), fullName: "Bilal Fictitious Ahmed", livenessSessionId: liveness(), wallet: wallet() });
    expect(r.status).toBe("review");
    const id = await caseOf(r.subjectId);
    const c = await kycCase(compA, id);
    expect(c).toMatchObject({ kind: "screening_match", risk: "high", flags: ["sanctions_possible_match"], status: "open" });
    expect(c.subject.cnic).toMatch(/^\*{5}-\*{4}\d{3}-\d$/);
    expect(JSON.stringify(c)).not.toMatch(/Bilal|Fictitious|35202/);

    expect(await act(compA, id, "approve")).toMatchObject({ ok: true, status: "pending_second" });
    // The proposer cannot confirm (in SQL), and the page explains it.
    expect((await kycCase(compA, id)).blockers.confirm.join(" ")).toMatch(/You proposed it/);
    expect(await act(compA, id, "confirm")).toMatchObject({ ok: false, error: expect.stringMatching(/maker-checker/) as unknown });
    expect(await act(compB, id, "confirm")).toMatchObject({ ok: true, status: "approved" });
    expect(await subjectStatus(db, r.subjectId)).toBe("verified");
    const row = await db.query<{ proposed_by: string; decided_by: string }>("SELECT proposed_by, decided_by FROM compliance.kyc_cases WHERE id = $1", [id]);
    expect(row.rows[0]).toEqual({ proposed_by: compA.handle, decided_by: compB.handle });
    const clr = await db.query<{ requested_by: string; decided_by: string; proposal: string }>("SELECT requested_by, decided_by, proposal FROM kyc.clearances WHERE subject_id = $1", [r.subjectId]);
    expect(clr.rows).toEqual([{ requested_by: compA.handle, decided_by: compB.handle, proposal: "false_positive" }]);
  });

  it("a PEP is accepted only after enhanced due diligence by two officers (accept_edd)", async () => {
    const r = await kyc.onboard({ cnic: cnic(), fullName: "Pervaiz Peptest", livenessSessionId: liveness(), wallet: wallet() });
    expect(r).toMatchObject({ status: "review", reason: expect.stringMatching(/PEP/) as unknown });
    const id = await caseOf(r.subjectId);
    expect((await kycCase(compA, id)).flags).toEqual(["pep"]);
    expect(await act(compB, id, "approve", "source of wealth documents verified (EDD)")).toMatchObject({ ok: true, status: "pending_second" });
    expect(await act(compA, id, "confirm", "EDD file reviewed, senior approval recorded")).toMatchObject({ ok: true, status: "approved" });
    expect(await statusOf(db, r.subjectId)).toMatchObject({ status: "verified", reason: expect.stringMatching(/PEP accepted after enhanced due diligence/) as unknown });
  });

  it("rejecting a screening match is also two-officer, and final (true match)", async () => {
    const r = await kyc.onboard({ cnic: cnic(), fullName: "Bilal Fictitious Raza", livenessSessionId: liveness(), wallet: wallet() });
    const id = await caseOf(r.subjectId);
    expect(await act(compA, id, "reject", "the identifiers match the listed person")).toMatchObject({ ok: true, status: "pending_second" });
    // A declined proposal goes back to open (the clearance is rejected in KYC too).
    expect(await act(compB, id, "decline", "date of birth differs, look again")).toMatchObject({ ok: true, status: "open" });
    expect(await act(compB, id, "reject", "second look confirms the list identity")).toMatchObject({ ok: true, status: "pending_second" });
    expect(await act(compA, id, "confirm", "agree, confirmed true match")).toMatchObject({ ok: true, status: "rejected" });
    expect(await subjectStatus(db, r.subjectId)).toBe("rejected");
  });

  it("a confirmed list hit is final: it can only be closed as rejected, by one officer", async () => {
    const r = await kyc.onboard({ cnic: cnic(), fullName: "Zargham Testkhan", livenessSessionId: liveness(), wallet: wallet() });
    expect(r.status).toBe("rejected");
    const id = await caseOf(r.subjectId);
    const c = await kycCase(compA, id);
    expect(c).toMatchObject({ kind: "sanctions_hit", risk: "high" });
    expect(c.blockers.approve.join(" ")).toMatch(/final/);
    expect(await act(compA, id, "approve")).toMatchObject({ ok: false, error: expect.stringMatching(/final/) as unknown });
    expect(await act(compA, id, "reject", "list hit confirmed, STR assessment opened")).toMatchObject({ ok: true, status: "rejected" });
    // Direct UPDATE to approved is refused by the table itself.
    expect(await pgCode(db.query("UPDATE compliance.kyc_cases SET status = 'open' WHERE id = $1", [id]))).toBe("23514");
  });

  it("manual cases: standard risk by one officer, high risk by two; information requests; rejection revokes", async () => {
    const a = await verifiedInvestor();
    const open = async (risk: string) => {
      const { rows } = await portal.query<{ r: { ok: boolean; id: number } }>("SELECT admin.open_kyc_case($1, $2, $3, $4) AS r", [
        compA.sessionHash,
        a.subjectId,
        risk,
        "adverse media article about the investor's business",
      ]);
      expect(rows[0]?.r.ok).toBe(true);
      return rows[0]?.r.id ?? 0;
    };
    const s = await open("standard");
    expect(await act(compA, s, "request_info", "asked for the source of funds letter")).toMatchObject({ ok: true, status: "info_requested" });
    expect(await act(compA, s, "approve")).toMatchObject({ ok: false, error: expect.stringMatching(/only an open case/) as unknown });
    expect(await act(compA, s, "info_received", "source of funds letter received")).toMatchObject({ ok: true, status: "open" });
    expect(await act(compA, s, "approve", "letter consistent with the profile")).toMatchObject({ ok: true, status: "approved" });

    const h = await open("standard");
    expect(await act(compB, h, "escalate", "media report names a proscribed group")).toMatchObject({ ok: true });
    expect(await act(compB, h, "approve", "explained by the investor, documented")).toMatchObject({ ok: true, status: "pending_second" });
    expect(await act(compA, h, "decline", "not convinced: more checks needed")).toMatchObject({ ok: true, status: "open" });
    // Rejection of a manual case revokes the verification (protective, one officer).
    expect(await act(compA, h, "reject", "relationship terminated by compliance")).toMatchObject({ ok: true, status: "rejected" });
    expect(await subjectStatus(db, a.subjectId)).toBe("revoked");
    // A superuser approving a high-risk case without a proposal by a second officer: refused by the table.
    const f = await open("high");
    expect(
      await pgCode(
        db.query("UPDATE compliance.kyc_cases SET status = 'approved', decided_by = 'rogue.dba', decision_reason = 'approved without a second officer', decided_at = now() WHERE id = $1", [f]),
      ),
    ).toBe("23514");
  });

  it("a newer screening supersedes an open screening case", async () => {
    const r = await kyc.onboard({ cnic: cnic(), fullName: "Bilal Fictitious Malik", livenessSessionId: liveness(), wallet: wallet() });
    const first = await caseOf(r.subjectId);
    await kyc.rescreen(r.subjectId);
    const second = await caseOf(r.subjectId);
    expect(second).toBeGreaterThan(first);
    expect((await kycCase(compA, first)).status).toBe("superseded");
    expect((await kycCase(compA, second)).status).toBe("open");
  });
});

describe("privacy, officers and roles (C-6, C-7, C-8)", () => {
  it("free text with a CNIC, an IBAN or a mobile number is refused", async () => {
    const a = await verifiedInvestor();
    for (const bad of ["CNIC 35202-1234567-1 belongs to him", "number 3520212345671 noted", "IBAN PK36SCBL0000001123456702", "call him on 0300 1234567"]) {
      const { rows } = await portal.query<{ r: { ok: boolean; error?: string } }>("SELECT admin.open_kyc_case($1, $2, 'standard', $3) AS r", [compA.sessionHash, a.subjectId, bad]);
      expect(rows[0]?.r, bad).toMatchObject({ ok: false, error: expect.stringMatching(/never a CNIC/) as unknown });
    }
  });

  it("operations officers cannot act on compliance; a stale step-up is refused", async () => {
    const a = await verifiedInvestor();
    expect(await pgCode(portal.query("SELECT admin.kyc_queue($1, NULL)", [opsChecker.sessionHash]))).toBe("42501");
    expect(await pgCode(portal.query("SELECT admin.open_kyc_case($1, $2, 'standard', 'operations trying to open a case')", [opsChecker.sessionHash, a.subjectId]))).toBe("42501");
    await db.query("ALTER TABLE admin.sessions DISABLE TRIGGER sessions_guard");
    await db.query("UPDATE admin.sessions SET step_up_at = step_up_at - interval '5 minutes 1 second' WHERE token_hash = $1", [compA.sessionHash]);
    await db.query("ALTER TABLE admin.sessions ENABLE TRIGGER sessions_guard");
    const { rows } = await portal.query<{ r: { id: number } }>("SELECT admin.open_kyc_case($1, $2, 'standard', 'opened without a step-up is fine') AS r", [compA.sessionHash, a.subjectId]);
    expect(await pgCode(portal.query("SELECT admin.kyc_case_act($1, $2, 'approve', 'stale step-up probe', $3)", [compA.sessionHash, rows[0]?.r.id, Buffer.alloc(32)]))).toBe("PTS01");
    compA = await officer(db, compA.handle, "compliance_officer");
  });

  it("officer handles are bound to sessions: the command line cannot use them for compliance or KYC clearances", async () => {
    const a = await verifiedInvestor();
    expect(await pgCode(db.query("SELECT compliance.open_kyc_case($1, 'standard', 'pretending to be the officer', $2)", [a.subjectId, compA.handle]))).toBe("42501");
    const r = await kyc.onboard({ cnic: cnic(), fullName: "Bilal Fictitious Qureshi", livenessSessionId: liveness(), wallet: wallet() });
    const check = await db.query<{ id: string }>("SELECT check_id AS id FROM compliance.kyc_cases WHERE subject_id = $1", [r.subjectId]);
    expect(await pgCode(db.query("SELECT kyc.request_clearance($1, $2, 'false_positive', 'pretending to be the officer')", [check.rows[0]?.id, compB.handle]))).toBe("42501");
    // Non-officer operator names keep working on the command line (break-glass, audited in KYC).
    expect((await db.query("SELECT kyc.request_clearance($1, 'officer:night', 'false_positive', 'command line operator name') AS id", [check.rows[0]?.id])).rowCount).toBe(1);
  });

  it("the portal's role reaches compliance only through admin.* (no table or compliance.* access)", async () => {
    for (const sql of [
      "SELECT * FROM compliance.kyc_cases",
      "SELECT compliance.open_kyc_case(gen_random_uuid(), 'standard', 'direct call from the portal', 'x.y')",
      "SELECT compliance.decide_freeze(1, 'x.y', 'approve', 'direct call from the portal')",
      "SELECT * FROM compliance.str_notes",
    ]) {
      expect(await pgCode(portal.query(sql)), sql).toBe("42501");
    }
  });
});

describe("re-screening through the KYC service (C-5)", () => {
  it("is queued in the portal, executed by the worker, and reported back; one live request per investor", async () => {
    const a = await verifiedInvestor();
    const ask = () => portal.query<{ r: { ok: boolean; id?: number; error?: string } }>("SELECT admin.request_rescreen($1, $2, 'list update 2026-10 weekly batch') AS r", [compA.sessionHash, a.subjectId]);
    expect((await ask()).rows[0]?.r.ok).toBe(true);
    expect((await ask()).rows[0]?.r).toMatchObject({ ok: false, error: expect.stringMatching(/already queued/) as unknown });
    // The worker runs as in production: a login in pt_svc_kyc (T-012, migration 0029), never the admin.
    const login = await serviceLogin("kyc", String(db.database));
    const svcPool = new pg.Pool({ ...login.settings, max: 2 });
    try {
      const asService = new KycService(svcPool, mockProviders(), peppers, kycDataKey);
      expect(await new RescreenWorker(svcPool, asService, { worker: "kyc-rescreen-test" }).runOnce()).toBe(1);
    } finally {
      await svcPool.end();
      await login.drop();
    }
    const { rows } = await db.query<{ status: string; result_status: string; check_id: string | null }>("SELECT status, result_status, check_id FROM compliance.rescreens WHERE subject_id = $1", [a.subjectId]);
    expect(rows[0]).toMatchObject({ status: "done", result_status: "verified" });
    expect(rows[0]?.check_id).not.toBeNull();
    // A provider outage is recorded as an error name, never a message.
    const b = await verifiedInvestor();
    const down = new KycService(pool, { ...mockProviders(), sanctions: Object.assign(new MockSanctions(), { unavailable: true }) }, peppers, randomBytes(32));
    await portal.query("SELECT admin.request_rescreen($1, $2, 'list update 2026-10 weekly batch')", [compA.sessionHash, b.subjectId]);
    expect(await new RescreenWorker(pool, down, { worker: "kyc-rescreen-test" }).runOnce()).toBe(1);
    const failed = await db.query<{ status: string; error: string }>("SELECT status, error FROM compliance.rescreens WHERE subject_id = $1", [b.subjectId]);
    expect(failed.rows[0]?.status).toBe("failed");
  });
});

describe("compliance audit (C-7)", () => {
  it("the chain verifies; rows written around the API and edited entries are found", async () => {
    expect((await db.query("SELECT * FROM compliance.verify_audit()")).rows).toEqual([]);
    expect((await db.query("SELECT * FROM admin.verify_audit()")).rows).toEqual([]);
    expect((await db.query("SELECT * FROM kyc.verify_audit()")).rows).toEqual([]);
    await db.query("BEGIN");
    const s = await db.query<{ id: string }>("SELECT id FROM kyc.subjects LIMIT 1");
    await db.query("INSERT INTO compliance.kyc_cases (subject_id, kind, risk, summary, opened_by) VALUES ($1, 'manual', 'standard', 'written around the API', 'rogue.dba')", [s.rows[0]?.id]);
    await db.query("ALTER TABLE compliance.audit DISABLE TRIGGER audit_append_only");
    await db.query("UPDATE compliance.audit SET actor = 'someone.else' WHERE id = (SELECT min(id) FROM compliance.audit)");
    const problems = (await db.query<{ problem: string }>("SELECT problem FROM compliance.verify_audit()")).rows.map((r) => r.problem).join("\n");
    await db.query("ROLLBACK");
    expect(problems).toMatch(/content does not match its hash/);
    expect(problems).toMatch(/KYC case \d+ has no matching audit entry/);
    // Append-only.
    expect(await pgCode(db.query("DELETE FROM compliance.kyc_case_events"))).toBe("42501");
    expect(await pgCode(db.query("TRUNCATE compliance.audit"))).toBe("42501");
  });
});
