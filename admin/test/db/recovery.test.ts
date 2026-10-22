import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { holder as fixtureHolder, RECOVERY_TOKEN, recoveryPolicies } from "../support/recovery";
import { cast, createWorld, invite, type Actor, type Cast, type World } from "../support/world";

/**
 * S-06 through the portal's own database functions (migration 0020): who may open, prepare and
 * decide a case, in which capacity, with a fresh step-up, bound to the digest the officer reviewed;
 * officer handles recorded; what the detail explains in advance. The rules themselves are covered
 * in depth by backend/packages/recovery/test/recovery.test.ts.
 */
let w: World;
let c: Cast;
let compliance2: Actor;
let counter = Date.now();

type R = { ok: boolean; id?: number; status?: string; error?: string };
interface Detail {
  id: number;
  status: string;
  digest: string;
  myCapacities: string[];
  approvals: { capacity: string; officer: string; decision: string }[];
  blockers: { maker: string[]; decide: string[]; approve: string[]; cancel: string[]; release: string[] };
  heirs: { share: string }[];
  allocationPreview: { units: string }[] | null;
  subject: { cnic: string } | null;
}

async function fresh(a: Actor): Promise<void> {
  await w.portal.query("SELECT admin.record_step_up($1, $2, $3)", [a.sessionHash, a.credentialId, ++counter]);
}
async function detail(a: Actor, id: number): Promise<Detail> {
  const { rows } = await w.portal.query<{ v: Detail }>("SELECT admin.recovery_case($1, $2) AS v", [a.sessionHash, id]);
  if (!rows[0]?.v) throw new Error(`no case ${String(id)}`);
  return rows[0].v;
}
async function act(a: Actor, id: number, action: string, capacity: string | null): Promise<R> {
  await fresh(a);
  const d = await detail(a, id);
  const { rows } = await w.portal.query<{ r: R }>("SELECT admin.recovery_act($1, $2, $3, $4, 'checked against the evidence on file', $5) AS r", [
    a.sessionHash, id, action, capacity, Buffer.from(d.digest, "hex"),
  ]);
  return rows[0]?.r ?? { ok: false };
}
async function open(a: Actor, kind: string, subject: string): Promise<R> {
  await fresh(a);
  const { rows } = await w.portal.query<{ r: R }>("SELECT admin.recovery_open($1, $2, $3, NULL, NULL, NULL, 'opened through the portal for the test') AS r", [a.sessionHash, kind, subject]);
  return rows[0]?.r ?? { ok: false };
}

const holder = (units: number) => fixtureHolder(w.su, units);
const frozen = (wallet: string) => w.su.query("INSERT INTO chain.freezes (token, holder, address_frozen, updated_block) VALUES ($1, $2, true, 2)", [RECOVERY_TOKEN, wallet]);

beforeAll(async () => {
  w = await createWorld();
  c = await cast(w);
  compliance2 = await invite(w, c.admin, c.admin2, "comp.second", "compliance_officer");
  await recoveryPolicies(w.su);
});
afterAll(async () => {
  await w.drop();
});

describe("wallet recovery through the portal", () => {
  let id = 0;
  let p: { subjectId: string; wallet: string };

  it("an operations maker opens it with a fresh step-up; the case and its freeze carry the officer's handle", async () => {
    p = await holder(250);
    // A stale step-up is refused by the database itself.
    await w.su.query("ALTER TABLE admin.sessions DISABLE TRIGGER sessions_guard");
    await w.su.query("UPDATE admin.sessions SET step_up_at = step_up_at - interval '6 minutes' WHERE token_hash = $1", [c.ops_maker.sessionHash]);
    await w.su.query("ALTER TABLE admin.sessions ENABLE TRIGGER sessions_guard");
    const stale = await w.portal.query("SELECT admin.recovery_open($1, 'wallet_recovery', $2, NULL, NULL, NULL, 'opened through the portal for the test')", [c.ops_maker.sessionHash, p.subjectId]).then(
      () => "ok",
      (e: unknown) => (e as { code?: string }).code,
    );
    expect(stale).toBe("PTS01");
    const r = await open(c.ops_maker, "wallet_recovery", p.subjectId);
    expect(r).toMatchObject({ ok: true, status: "opened" });
    id = r.id ?? 0;
    const row = await w.su.query<{ opened_by: string; freeze_key: string }>("SELECT opened_by, freeze_key FROM recovery.cases WHERE id = $1", [id]);
    expect(row.rows[0]?.opened_by).toBe(c.ops_maker.handle);
    const cmd = await w.su.query<{ kind: string; created_by: string }>("SELECT kind, created_by FROM outbox.commands WHERE idempotency_key = $1", [row.rows[0]?.freeze_key]);
    expect(cmd.rows[0]).toEqual({ kind: "recovery.freeze", created_by: c.ops_maker.handle });
    // Refusals come back explained and audited (no second live case for the wallet).
    expect((await open(c.ops_maker, "wallet_recovery", p.subjectId)).error).toMatch(/live recovery or succession case/);
  });

  it("the detail explains in advance who may do what, and why approval is not possible yet", async () => {
    const asMaker = await detail(c.ops_maker, id);
    expect(asMaker.blockers.maker).toEqual([]);
    expect(asMaker.blockers.decide.join(" ")).toMatch(/Only operations checkers, compliance and legal officers decide/);
    const asComp = await detail(c.compliance_officer, id);
    expect(asComp.myCapacities).toEqual(["compliance"]);
    expect(asComp.blockers.approve.join(" ")).toMatch(/objection window runs until/);
    expect(asComp.blockers.maker.join(" ")).toMatch(/Only an operations maker prepares a case/);
    const asLegal = await detail(c.legal_officer, id);
    expect(asLegal.myCapacities).toEqual([]);
    expect(asLegal.blockers.decide.join(" ")).toMatch(/decided as operations and compliance: you hold neither role/);
    expect(asComp.subject?.cnic).toMatch(/^\*{5}-\*{4}\d{3}-\d$/);
  });

  it("two officers in their capacities through the portal; a legal officer and the same officer twice are refused", async () => {
    await w.su.query("ALTER TABLE recovery.cases DISABLE TRIGGER cases_guard");
    await w.su.query("UPDATE recovery.cases SET objection_until = now() - interval '1 second' WHERE id = $1", [id]);
    await w.su.query("ALTER TABLE recovery.cases ENABLE TRIGGER cases_guard");
    await frozen(p.wallet);
    const custodial = `0x${randomBytes(20).toString("hex")}`;
    await w.su.query("SELECT signer.register_custodial_wallet($1, 'generated', 'admin-portal')", [custodial]);
    await fresh(c.ops_maker);
    expect((await w.portal.query<{ r: R }>("SELECT admin.recovery_set_wallet($1, $2, $3) AS r", [c.ops_maker.sessionHash, id, custodial])).rows[0]?.r).toMatchObject({ ok: true });
    for (const k of ["nadra", "liveness"]) {
      await w.su.query("SELECT kyc.record_check($1, $2, 'pass', 'mock-test', $3, $4, $5::smallint, NULL, $6, 'kyc-service')", [
        p.subjectId, k, `REF-${randomBytes(8).toString("hex")}`, k === "nadra" ? "match" : "live", k === "nadra" ? null : 93, randomBytes(32),
      ]);
    }
    expect(await act(c.legal_officer, id, "approve", "legal")).toMatchObject({ ok: false, error: expect.stringMatching(/capacities operations and compliance/) as unknown });
    expect(await act(c.compliance_officer, id, "approve", "operations")).toMatchObject({ ok: false, error: expect.stringMatching(/do not hold the ops_checker role/) as unknown });
    expect(await act(c.ops_checker, id, "approve", "operations")).toMatchObject({ ok: true, status: "opened" });
    expect(await act(c.ops_checker, id, "approve", "operations")).toMatchObject({ ok: false });
    // A changed case (digest) is refused: what you see is what you decide.
    await fresh(c.compliance_officer);
    const forged = await w.portal.query<{ r: R }>("SELECT admin.recovery_act($1, $2, 'approve', 'compliance', 'checked against the evidence', $3) AS r", [c.compliance_officer.sessionHash, id, Buffer.alloc(32)]);
    expect(forged.rows[0]?.r.error).toMatch(/differs from what you reviewed/);
    expect(await act(c.compliance_officer, id, "approve", "compliance")).toMatchObject({ ok: true, status: "approved" });
    const d = await detail(c.auditor, id);
    expect(d.approvals.map((x) => [x.capacity, x.officer])).toEqual([["operations", c.ops_checker.handle], ["compliance", c.compliance_officer.handle]]);
    const cmds = await w.su.query<{ kind: string }>("SELECT kind FROM outbox.commands WHERE created_by = $1 ORDER BY id", [c.compliance_officer.handle]);
    expect(cmds.rows.map((r) => r.kind)).toEqual(["recovery.add_key", "recovery.propose"]);
  });

  it("cancel by a decider, then release by two different compliance officers", async () => {
    expect(await act(c.compliance_officer, id, "release", null)).toMatchObject({ ok: false, error: expect.stringMatching(/only an executed, rejected or cancelled/) as unknown });
    expect(await act(c.ops_checker, id, "cancel", null)).toMatchObject({ ok: true, status: "cancelled" });
    expect(await act(c.ops_checker, id, "release", null)).toMatchObject({ ok: false, error: expect.stringMatching(/only a compliance officer releases/) as unknown });
    expect(await act(c.compliance_officer, id, "release", null)).toMatchObject({ ok: true, status: "cancelled" });
    expect(await act(c.compliance_officer, id, "release", null)).toMatchObject({ ok: false, error: expect.stringMatching(/a different compliance officer confirms/) as unknown });
    expect(await act(compliance2, id, "release", null)).toMatchObject({ ok: true, status: "closed" });
    const u = await w.su.query<{ kind: string; payload: { account: string } }>("SELECT kind, payload FROM outbox.commands WHERE created_by = $1 AND kind = 'recovery.unfreeze'", [compliance2.handle]);
    expect(u.rows[0]?.payload.account).toBe(p.wallet);
  });
});

describe("succession through the portal", () => {
  it("documents and heirs by the maker, legal and compliance decide; the allocation preview is shown", async () => {
    const deceased = await holder(10);
    const heirs = [await holder(0), await holder(0)];
    const r = await open(c.ops_maker, "succession", deceased.subjectId);
    const id = r.id ?? 0;
    await frozen(deceased.wallet);
    for (const [type, ref] of [["death_certificate", "NADRA death certificate D-77"], ["succession_certificate", "Succession certificate SC-12/2026"]]) {
      const d = await w.portal.query<{ r: R }>("SELECT admin.recovery_add_document($1, $2, $3, $4, NULL, $5) AS r", [c.ops_maker.sessionHash, id, type, ref, randomBytes(32).toString("hex")]);
      expect(d.rows[0]?.r.ok).toBe(true);
    }
    const bad = await w.portal.query<{ r: R }>("SELECT admin.recovery_add_document($1, $2, 'other', 'phone 03001234567', NULL, $3) AS r", [c.ops_maker.sessionHash, id, "ab".repeat(32)]);
    expect(bad.rows[0]?.r.error).toMatch(/never a CNIC, IBAN or phone number/);
    for (const [h, num, den] of [[heirs[0], 2, 3], [heirs[1], 1, 3]] as const) {
      const x = await w.portal.query<{ r: R }>("SELECT admin.recovery_add_heir($1, $2, $3, $4, $5) AS r", [c.ops_maker.sessionHash, id, h?.subjectId, num, den]);
      expect(x.rows[0]?.r.ok).toBe(true);
    }
    const before = await detail(c.legal_officer, id);
    expect(before.myCapacities).toEqual(["legal"]);
    expect(before.heirs.map((h) => h.share)).toEqual(["2/3", "1/3"]);
    expect(before.allocationPreview?.map((a) => a.units)).toEqual(["6", "3"]);
    expect(await act(c.ops_checker, id, "approve", "operations")).toMatchObject({ ok: false, error: expect.stringMatching(/capacities legal and compliance/) as unknown });
    expect(await act(c.legal_officer, id, "approve", "legal")).toMatchObject({ ok: true, status: "opened" });
    expect(await act(c.compliance_officer, id, "approve", "compliance")).toMatchObject({ ok: true, status: "approved" });
    const units = await w.su.query<{ amount: string }>("SELECT amount::text FROM recovery.proposals WHERE case_id = $1 ORDER BY id", [id]);
    expect(units.rows.map((x) => x.amount)).toEqual(["6", "3"]);
    // The maker can no longer change a decided case.
    const late = await w.portal.query<{ r: R }>("SELECT admin.recovery_add_heir($1, $2, $3, 1, 3) AS r", [c.ops_maker.sessionHash, id, heirs[1]?.subjectId]);
    expect(late.rows[0]?.r.error).toMatch(/only before any approval/);
  });
});

describe("trail", () => {
  it("the recovery and admin audit chains verify; the recovery chain is readable in the audit viewer", async () => {
    expect((await w.su.query("SELECT * FROM recovery.verify_audit()")).rows).toEqual([]);
    expect((await w.su.query("SELECT * FROM admin.verify_audit()")).rows).toEqual([]);
    const rows = await w.portal.query<{ action: string }>("SELECT action FROM admin.audit_rows($1, 'recovery', NULL, NULL, NULL, NULL, NULL, 200)", [c.auditor.sessionHash]);
    expect(rows.rows.map((r) => r.action)).toEqual(expect.arrayContaining(["case.opened", "case.decided", "case.approved", "case.cancelled", "case.released"]));
    const actions = (await w.su.query<{ action: string }>("SELECT DISTINCT action FROM admin.audit")).rows.map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(["recovery.requested", "recovery.decided", "approval.refused"]));
  });
});
