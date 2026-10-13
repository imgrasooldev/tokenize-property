import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { caseOf, freezePolicies, investor } from "../support/compliance";
import { cast, createWorld, invite, verify, type Actor, type Cast, type World } from "../support/world";

/**
 * Step 6c database rules (migration 0019) through the portal's own login: the portal reaches the
 * compliance schema only through admin.*; every decision needs a fresh step-up; a high-risk KYC
 * approval, a freeze and closing an STR without a report need a second, different compliance
 * officer; what the officer saw is bound by a digest; reads carry no personal data; the compliance
 * and admin chains verify.
 */
let w: World;
let c: Cast;
let comp2: Actor;
let counter = Date.now();
type R = { ok: boolean; id?: number; status?: string; error?: string };

beforeAll(async () => {
  w = await createWorld();
  c = await cast(w);
  comp2 = await invite(w, c.admin, c.admin2, "compliance.two", "compliance_officer");
  await freezePolicies(w.su);
});
afterAll(async () => {
  await w.drop();
});

async function code(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
    return undefined;
  } catch (e) {
    return (e as { code?: string }).code;
  }
}

async function stepUp(a: Actor, stale = false): Promise<void> {
  await w.portal.query("SELECT admin.record_step_up($1, $2, $3)", [a.sessionHash, a.credentialId, ++counter]);
  if (stale) {
    await w.su.query("ALTER TABLE admin.sessions DISABLE TRIGGER sessions_guard");
    await w.su.query("UPDATE admin.sessions SET step_up_at = step_up_at - interval '5 minutes 1 second' WHERE token_hash = $1", [a.sessionHash]);
    await w.su.query("ALTER TABLE admin.sessions ENABLE TRIGGER sessions_guard");
  }
}

async function one<T>(sql: string, params: unknown[]): Promise<T> {
  const { rows } = await w.portal.query<{ r: T }>(sql, params);
  return rows[0]?.r as T;
}

async function caseAct(a: Actor, id: string, action: string): Promise<R> {
  const d = await one<{ digest: string }>("SELECT admin.kyc_case($1, $2) AS r", [a.sessionHash, id]);
  await stepUp(a);
  return one<R>("SELECT admin.kyc_case_act($1, $2, $3, 'reviewed in full by the officer', $4) AS r", [a.sessionHash, id, action, Buffer.from(d.digest, "hex")]);
}

describe("the portal reaches compliance only through admin.*", () => {
  it("its role has no access to compliance tables or compliance.* / kyc decision functions", async () => {
    for (const sql of [
      "SELECT * FROM compliance.kyc_cases",
      "SELECT * FROM compliance.str_notes",
      "SELECT * FROM compliance.audit",
      "SELECT compliance.kyc_case_act(1, 'x.y', 'approve', 'portal trying directly')",
      "SELECT compliance.decide_freeze(1, 'x.y', 'approve', 'portal trying directly')",
      "SELECT compliance.str_act(1, 'x.y', 'start_review', 'portal trying directly', NULL)",
      "SELECT kyc.request_clearance(1, 'x.y', 'false_positive', 'portal trying directly')",
      "SELECT kyc.revoke(gen_random_uuid(), 'x.y', 'portal trying directly')",
      "SELECT * FROM kyc.subjects",
    ]) {
      expect(await code(w.portal.query(sql)), sql).toBe("42501");
    }
  });
});

describe("step-up for every compliance decision", () => {
  it("refuses with PTS01 when the last assertion is older than five minutes", async () => {
    await stepUp(c.compliance_officer, true);
    const z = `\\x${"00".repeat(32)}`;
    for (const sql of [
      `SELECT admin.kyc_case_act($1, 1, 'approve', 'stale step-up probe', '${z}')`,
      "SELECT admin.request_freeze($1, 'freeze', '0x0000000000000000000000000000000000000001', 'court_order', 'stale step-up probe', NULL, NULL)",
      `SELECT admin.decide_freeze($1, 1, 'approve', 'stale step-up probe', '${z}')`,
      `SELECT admin.str_act($1, 1, 'start_review', 'stale step-up probe', NULL, '${z}')`,
      `SELECT admin.record_str_export($1, 1, '${"a".repeat(64)}')`,
    ]) {
      expect(await code(w.portal.query(sql, [c.compliance_officer.sessionHash])), sql).toBe("PTS01");
    }
  });
});

describe("KYC review cases through the portal", () => {
  it("a possible match: maker-checker by two compliance officers, bound to what was seen; reads hold no personal data", async () => {
    const inv = await investor(w.su, { screening: "review" });
    const id = await caseOf(w.su, inv.subjectId);
    expect(id).not.toBe("");
    const view = await one<Record<string, unknown>>("SELECT admin.kyc_case($1, $2) AS r", [c.compliance_officer.sessionHash, id]);
    const text = JSON.stringify(view);
    expect(text).not.toMatch(/name_enc|name_hash|cnic_hash|evidence|iban/i);
    expect(text).toContain(`*****-****${inv.last4.slice(0, 3)}-${inv.last4.slice(3)}`);
    // A stale digest is refused.
    await stepUp(c.compliance_officer);
    const stale = await one<R>("SELECT admin.kyc_case_act($1, $2, 'approve', 'reviewed in full by the officer', $3) AS r", [
      c.compliance_officer.sessionHash,
      id,
      createHash("sha256").update("other").digest(),
    ]);
    expect(stale.error).toMatch(/differs from what you reviewed/);
    expect(await caseAct(c.compliance_officer, id, "approve")).toMatchObject({ ok: true, status: "pending_second" });
    expect(await caseAct(c.compliance_officer, id, "confirm")).toMatchObject({ ok: false, error: expect.stringMatching(/maker-checker/) as unknown });
    expect(await caseAct(comp2, id, "confirm")).toMatchObject({ ok: true, status: "approved" });
    expect((await w.su.query<{ s: string }>("SELECT kyc.subject_status($1) AS s", [inv.subjectId])).rows[0]?.s).toBe("verified");
    // The ops checker (the one role compatible with compliance) cannot act through compliance without the role.
    expect(await code(w.portal.query("SELECT admin.kyc_case($1, $2)", [c.ops_checker.sessionHash, id]))).toBe("42501");
  });
});

describe("freezes through the portal", () => {
  it("proposer never decides; approval holds the investor and queues exactly one outbox command", async () => {
    const inv = await investor(w.su);
    await stepUp(c.compliance_officer);
    const req = await one<R>("SELECT admin.request_freeze($1, 'freeze', $2, 'suspicious_activity', 'STR case under review, hold assets', NULL, NULL) AS r", [
      c.compliance_officer.sessionHash,
      inv.wallet,
    ]);
    expect(req.ok).toBe(true);
    const decide = async (a: Actor) => {
      const d = await one<{ digest: string; blockers: string[] }>("SELECT admin.freeze_request($1, $2) AS r", [a.sessionHash, req.id]);
      await stepUp(a);
      return {
        blockers: d.blockers,
        r: await one<R>("SELECT admin.decide_freeze($1, $2, 'approve', 'assessed: freeze is proportionate', $3) AS r", [a.sessionHash, req.id, Buffer.from(d.digest, "hex")]),
      };
    };
    const mine = await decide(c.compliance_officer);
    expect(mine.blockers.join(" ")).toMatch(/You proposed/);
    expect(mine.r.error).toMatch(/maker-checker/);
    expect((await decide(comp2)).r).toMatchObject({ ok: true, status: "approved" });
    expect((await w.su.query<{ s: string }>("SELECT kyc.subject_status($1) AS s", [inv.subjectId])).rows[0]?.s).toBe("suspended");
    const cmds = await w.su.query<{ kind: string; created_by: string }>("SELECT kind, created_by FROM outbox.commands WHERE idempotency_key = $1", [
      `compliance.freeze:request:${String(req.id)}`,
    ]);
    expect(cmds.rows).toEqual([{ kind: "compliance.freeze", created_by: comp2.handle }]);
  });
});

describe("STR cases through the portal", () => {
  it("closing without a report needs a second officer; filing needs an export first; notes are append-only", async () => {
    const opened = await one<R>("SELECT admin.open_str($1, NULL, 'structuring', 'Several deposits just below the reporting threshold in one week') AS r", [c.compliance_officer.sessionHash]);
    expect(opened.ok).toBe(true);
    const id = opened.id;
    expect((await one<R>("SELECT admin.add_str_note($1, $2, 'bank statements requested from the trustee bank') AS r", [comp2.sessionHash, id])).ok).toBe(true);
    const act = async (a: Actor, action: string, fmu: string | null = null) => {
      const d = await one<{ digest: string }>("SELECT admin.str_case($1, $2) AS r", [a.sessionHash, id]);
      await stepUp(a);
      return one<R>("SELECT admin.str_act($1, $2, $3, 'assessed against the investor profile', $4, $5) AS r", [a.sessionHash, id, action, fmu, Buffer.from(d.digest, "hex")]);
    };
    expect(await act(c.compliance_officer, "propose_close")).toMatchObject({ ok: true, status: "close_proposed" });
    expect((await act(c.compliance_officer, "confirm_close")).error).toMatch(/maker-checker/);
    expect(await act(comp2, "decline_close")).toMatchObject({ ok: true, status: "under_review" });
    expect((await act(comp2, "mark_filed", "FMU/2026/0042")).error).toMatch(/export the case/);
    await stepUp(comp2);
    expect((await one<R>("SELECT admin.record_str_export($1, $2, $3) AS r", [comp2.sessionHash, id, "e".repeat(64)])).ok).toBe(true);
    expect(await act(comp2, "mark_filed", "FMU/2026/0042")).toMatchObject({ ok: true, status: "filed" });
    expect(await code(w.su.query("UPDATE compliance.str_notes SET body = 'rewritten'"))).toBe("42501");
    // Auditors read the case but cannot export it.
    expect(await code(w.portal.query("SELECT admin.str_case($1, $2)", [c.auditor.sessionHash, id]))).toBeUndefined();
    expect(await code(w.portal.query("SELECT admin.str_export_data($1, $2)", [c.auditor.sessionHash, id]))).toBe("42501");
  });
});

describe("audit", () => {
  it("compliance and admin chains verify; decisions and refusals are recorded", async () => {
    const actions = (await w.su.query<{ action: string }>("SELECT DISTINCT action FROM admin.audit")).rows.map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(["compliance.decided", "compliance.requested", "compliance.exported", "approval.refused"]));
    expect(await verify(w)).toEqual([]);
    expect((await w.su.query("SELECT * FROM compliance.verify_audit()")).rows).toEqual([]);
  });
});
