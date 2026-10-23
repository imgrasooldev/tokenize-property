import { randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { officer, type TestOfficer } from "../../db/test/officers.ts";
import {
  allowPlaceholders,
  calculate,
  cnic,
  collect,
  createWorld,
  investor,
  publishAndBook,
  token,
  transfer,
  ZERO,
  type Investor,
  type World,
} from "../../tax/test/world.ts";
import { sweep, verifyAudit } from "../src/service.ts";
import { kindsOf, notesOf, producerFailureCount } from "./helpers.ts";

/**
 * Migration 0030 producers of KYC and compliance (generic investor notices, no tipping-off: NP-4;
 * compliance queues and service levels for officers) and of S-03 operations and tax (rent credited,
 * tax certificate, the trustee's pre-check and the checker's approval waiting), on the tax world.
 */

let w: World;
let portal: pg.Client;
let compA: TestOfficer;
let compB: TestOfficer;
const TRUSTEE = "trustee.tax.test";
const CHECKER = "ops.checker.tax";

beforeAll(async () => {
  w = await createWorld();
  portal = new pg.Client(w.settings);
  await portal.connect();
  await portal.query("SET ROLE pt_admin_portal");
  compA = await officer(w.su, "comp.np.a", "compliance_officer");
  compB = await officer(w.su, "comp.np.b", "compliance_officer");
  await officer(w.su, TRUSTEE, "trustee_officer");
  await officer(w.su, CHECKER, "ops_checker");
}, 180_000);
afterAll(async () => {
  await portal.end();
  await w.drop();
}, 120_000);

const wallet = (): string => `0x${randomBytes(20).toString("hex")}`;
let n = 0;
async function onboard(fullName: string): Promise<{ subjectId: string; status: string; wallet: string }> {
  const wl = wallet();
  const r = await w.kyc.onboard({ cnic: cnic(1), fullName, livenessSessionId: `sess-np-${String(++n).padStart(6, "0")}`, wallet: wl });
  return { subjectId: r.subjectId, status: r.status, wallet: wl };
}

async function caseOf(subjectId: string): Promise<number> {
  const { rows } = await w.su.query<{ id: string }>("SELECT id FROM compliance.kyc_cases WHERE subject_id = $1 ORDER BY id DESC LIMIT 1", [subjectId]);
  return Number(rows[0]?.id ?? 0);
}

async function act(o: TestOfficer, id: number, action: string, reason: string): Promise<{ ok: boolean; status?: string; error?: string }> {
  const c = await portal.query<{ v: { digest: string } }>("SELECT admin.kyc_case($1, $2) AS v", [o.sessionHash, id]);
  const { rows } = await portal.query<{ r: { ok: boolean; status?: string; error?: string } }>("SELECT admin.kyc_case_act($1, $2, $3, $4, $5) AS r", [
    o.sessionHash,
    id,
    action,
    reason,
    Buffer.from(c.rows[0]?.v.digest ?? "", "hex"),
  ]);
  return rows[0]?.r ?? { ok: false };
}

const waitingFor = async (handle: string, prefix: string) => (await notesOf(w.pool, "officer", handle, "officer.action_waiting")).filter((x) => x.key.startsWith(prefix));

describe("KYC and compliance producers (NP-4)", () => {
  it("verification: one generic notice; a repeated evaluation (retry) adds none", async () => {
    const a = await onboard("Hina Verified");
    expect(a.status).toBe("verified");
    expect((await notesOf(w.pool, "investor", a.subjectId)).map((x) => [x.kind, x.params.status])).toEqual([["security.kyc_status_changed", "verified"]]);
    await w.su.query("SELECT kyc.evaluate($1, 'kyc-service')", [a.subjectId]);
    await w.su.query("SELECT kyc.evaluate($1, 'kyc-service')", [a.subjectId]);
    expect(await kindsOf(w.pool, a.subjectId)).toEqual(["security.kyc_status_changed"]);
  });

  it("a possible sanctions match or a list hit tells the investor NOTHING; the compliance officers see a KYC review waiting", async () => {
    const possible = await onboard("Bilal Fictitious Ahmed");
    expect(possible.status).toBe("review");
    const hit = await onboard("Zargham Testkhan");
    expect(hit.status).toBe("rejected");
    const pep = await onboard("Pervaiz Peptest");
    expect(pep.status).toBe("review");
    for (const s of [possible, hit, pep]) {
      expect(await kindsOf(w.pool, s.subjectId), s.status).toEqual([]);
      const c = await caseOf(s.subjectId);
      expect(c).toBeGreaterThan(0);
      for (const o of [compA, compB]) {
        const x = await waitingFor(o.handle, `compliance:kyc-case:${String(c)}:`);
        expect(x).toHaveLength(1);
        expect(x[0]?.params).toEqual({ queue: "kyc_review", reference: `KC-${String(c)}` });
      }
    }
  });

  it("a manual case: the information request reaches the investor as 'action required' only; rejection (revocation) tells nothing", async () => {
    const a = await onboard("Sana Manualcase");
    const { rows } = await portal.query<{ r: { ok: boolean; id: number } }>("SELECT admin.open_kyc_case($1, $2, 'standard', $3) AS r", [
      compA.sessionHash,
      a.subjectId,
      "adverse media article about the investor's business",
    ]);
    const id = rows[0]?.r.id ?? 0;
    // Opened by compA: compB is told, compA (the opener) is not.
    expect(await waitingFor(compB.handle, `compliance:kyc-case:${String(id)}:`)).toHaveLength(1);
    expect(await waitingFor(compA.handle, `compliance:kyc-case:${String(id)}:`)).toHaveLength(0);
    expect(await act(compA, id, "request_info", "asked for the source of funds letter")).toMatchObject({ ok: true, status: "info_requested" });
    const notes = await notesOf(w.pool, "investor", a.subjectId, "security.kyc_status_changed");
    expect(notes.map((x) => x.params.status)).toEqual(["verified", "action_required"]);
    expect(await act(compA, id, "info_received", "source of funds letter received")).toMatchObject({ ok: true, status: "open" });
    expect(await act(compA, id, "reject", "relationship terminated after review")).toMatchObject({ ok: true, status: "rejected" });
    expect(await kindsOf(w.pool, a.subjectId)).toEqual(["security.kyc_status_changed", "security.kyc_status_changed"]);
  });

  it("a compliance hold request tells the investor nothing; the other compliance officer is asked to decide", async () => {
    const a = await onboard("Usman Holdtest");
    const before = await kindsOf(w.pool, a.subjectId);
    const { rows } = await portal.query<{ r: { ok: boolean; id: number; error?: string } }>("SELECT admin.request_freeze($1, 'freeze', $2, 'court_order', $3, NULL, NULL) AS r", [
      compA.sessionHash,
      a.wallet,
      "court order received from the district court",
    ]);
    expect(rows[0]?.r.ok, rows[0]?.r.error).toBe(true);
    const id = rows[0]?.r.id ?? 0;
    expect((await waitingFor(compB.handle, `compliance:hold-request:${String(id)}:`)).map((x) => x.params.queue)).toEqual(["freeze_decision"]);
    expect(await waitingFor(compA.handle, `compliance:hold-request:${String(id)}:`)).toHaveLength(0);
    expect(await kindsOf(w.pool, a.subjectId)).toEqual(before);
  });

  it("time-based: an expired verification is told once; a case past its service level alerts compliance once", async () => {
    const a = await onboard("Zainab Expiring");
    await w.su.query("ALTER TABLE kyc.decisions DISABLE TRIGGER USER");
    try {
      await w.su.query("UPDATE kyc.decisions SET valid_until = now() - interval '1 day' WHERE subject_id = $1 AND status = 'verified'", [a.subjectId]);
    } finally {
      await w.su.query("ALTER TABLE kyc.decisions ENABLE TRIGGER USER");
    }
    const b = await onboard("Kamran Slowcase");
    const { rows } = await portal.query<{ r: { id: number } }>("SELECT admin.open_kyc_case($1, $2, 'standard', $3) AS r", [compA.sessionHash, b.subjectId, "source of funds unclear for a large deposit"]);
    const id = rows[0]?.r.id ?? 0;
    await w.su.query("ALTER TABLE compliance.kyc_cases DISABLE TRIGGER USER");
    try {
      await w.su.query("UPDATE compliance.kyc_cases SET updated_at = now() - interval '3 days' WHERE id = $1", [id]);
    } finally {
      await w.su.query("ALTER TABLE compliance.kyc_cases ENABLE TRIGGER USER");
    }
    await sweep(w.pool);
    await sweep(w.pool);
    expect((await notesOf(w.pool, "investor", a.subjectId, "security.kyc_status_changed")).map((x) => x.params.status)).toEqual(["verified", "expired"]);
    for (const o of [compA, compB]) {
      const alerts = (await notesOf(w.pool, "officer", o.handle, "officer.alert")).filter((x) => x.key.startsWith(`sla:kyc-case:${String(id)}:`));
      expect(alerts).toHaveLength(1);
      expect(alerts[0]?.params).toMatchObject({ topic: "sla_breach", reference: `KC-${String(id)}` });
    }
    expect(await kindsOf(w.pool, b.subjectId)).toEqual(["security.kyc_status_changed"]);
  });
});

describe("operations and tax producers (S-03)", () => {
  it("rent distribution: the trustee's pre-check and the checker's approval are asked for; booking credits each investor once", async () => {
    await allowPlaceholders(w, true);
    const today = (await w.su.query<{ d: string }>("SELECT ops.pkt_today()::text AS d")).rows[0]?.d ?? "";
    const holders: Investor[] = [await investor(w), await investor(w)];
    const tk = await token(w);
    for (const [i, h] of holders.entries()) await transfer(w, tk, ZERO, h.wallet, BigInt(1000 * (i + 1)), 2);
    await collect(w, tk, "2026-09-12", 6_000_000n);
    const calc = await calculate(w, tk, "2026-09", today, 3);
    const before = await Promise.all(holders.map((h) => kindsOf(w.pool, h.subjectId)));
    await publishAndBook(w, tk, calc, 1);
    expect((await waitingFor(TRUSTEE, `ops:distribution:${calc}:precheck:`)).map((x) => x.params)).toEqual([{ queue: "trustee_precheck", reference: `DC-${calc}` }]);
    expect((await waitingFor(CHECKER, `ops:distribution:${calc}:approval:`)).map((x) => x.params.queue)).toEqual(["distribution_approval"]);
    for (const [i, h] of holders.entries()) {
      const credited = await notesOf(w.pool, "investor", h.subjectId, "rent.distributed");
      expect(credited).toHaveLength(1);
      expect(credited[0]?.params.period).toBe("2026-09");
      expect(BigInt(credited[0]?.params.amount_paisa ?? "0")).toBeGreaterThan(0n);
      // eslint-disable-next-line security/detect-object-injection -- index of the same array
      expect(await kindsOf(w.pool, h.subjectId)).toEqual([...(before[i] ?? []), "rent.distributed"]);
    }
  });

  it("tax certificate: one notice per issued certificate; issuing the same content again adds none", async () => {
    const h = await investor(w);
    const fy = 2027;
    const issue = async (): Promise<string> =>
      (await w.ops.query<{ id: string }>("SELECT tax.issue_certificate($1, $2, 'operator:omar')::text AS id", [h.subjectId, fy])).rows[0]?.id ?? "";
    const c1 = await issue();
    expect(await issue()).toBe(c1);
    const notes = await notesOf(w.pool, "investor", h.subjectId, "tax.certificate_available");
    expect(notes).toHaveLength(1);
    expect(notes[0]?.params).toEqual({ fiscal_year: "FY2027" });
  });

  it("no producer failed and the notify audit chain verifies", async () => {
    expect(await producerFailureCount(w.pool)).toBe(0);
    expect(await verifyAudit(w.pool)).toEqual([]);
  });
});
