import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { changeOfficer, officer, type TestOfficer } from "../../db/test/officers.ts";
import { PropertyError, sponsorState, verifyAudit, type PropertyErrorCode } from "../src/service.ts";
import { draftSponsor, hex, makeWorld, O, type World } from "./world.ts";

/**
 * Step 6b (migration 0016): S-01 maker-checker requests decided through the admin portal's database
 * API, and S-01 duties linked to portal officers (A-7).
 */
let w: World;
let portal: pg.Client;

beforeAll(async () => {
  w = await makeWorld();
  portal = new pg.Client(w.settings);
  await portal.connect();
  // Exactly the rights of the portal's login (member of pt_admin_portal only).
  await portal.query("SET ROLE pt_admin_portal");
}, 180_000);

afterAll(async () => {
  await portal.end();
  await w.drop();
}, 180_000);

async function refused(p: Promise<unknown>, code: PropertyErrorCode, msg?: RegExp): Promise<void> {
  await expect(p).rejects.toSatisfy((e: unknown) => e instanceof PropertyError && e.code === code && (!msg || msg.test(e.message)));
}

async function pgCode(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
    return undefined;
  } catch (e) {
    return (e as { code?: string }).code;
  }
}

/** A sponsor in KYB review with every K4 guard met and an open K4 request by comp-1. */
async function k4Request(): Promise<{ sponsorId: string; request: string }> {
  const s = await draftSponsor(w);
  await w.run("submitKyb", { sponsorId: s.sponsorId, actor: O.onb1, actingFor: s.repId });
  await w.run("screenKyb", { sponsorId: s.sponsorId, actor: O.onb2, accept: true });
  await w.run("recordRegistrationCheck", { sponsorId: s.sponsorId, method: "secp_eservices", outcome: "verified", evidence: hex(), actor: O.onb2 });
  await w.run("recordScreening", { sponsorId: s.sponsorId, provider: "mock-screen", listVersion: "un-2026-10", outcome: "clear", evidence: hex(), actor: O.comp1 });
  await w.run("recordRisk", { sponsorId: s.sponsorId, rating: "low", reasons: "listed group, simple ownership", actor: O.comp1 });
  const request = await w.run("requestTransition", { entity: "sponsor", id: s.sponsorId, code: "K4", officer: O.comp1, reason: "all KYB checks complete and clear" });
  return { sponsorId: s.sponsorId, request: request.toString() };
}

type Detail = { digest: string; blockers: string[]; code: string; sponsor: { state: string; cuinLast4: string } | null; checkerDuties: string[] };
const detail = async (o: TestOfficer, id: string): Promise<Detail> =>
  (await portal.query<{ d: Detail }>("SELECT admin.property_request($1, $2) AS d", [o.sessionHash, id])).rows[0]?.d as Detail;
const decide = async (o: TestOfficer, id: string, decision: string, digest: string, reason = "reviewed the KYB file, all clear") =>
  (await portal.query<{ r: { ok: boolean; status?: string; error?: string } }>("SELECT admin.decide_property_request($1, $2, $3, $4, $5) AS r", [
    o.sessionHash,
    id,
    decision,
    reason,
    Buffer.from(digest, "hex"),
  ])).rows[0]?.r;

describe("S-01 requests decided in the portal (Step 6b)", () => {
  it("the backend enforces maker-checker and duties; an approval moves the file; both audits record it", async () => {
    const { sponsorId, request } = await k4Request();
    const comp1 = await officer(w.client, O.comp1, "compliance_officer");
    const comp2 = await officer(w.client, O.comp2, "compliance_officer");
    const onb1 = await officer(w.client, O.onb1, "ops_maker");

    const seen = await detail(comp2, request);
    expect(seen).toMatchObject({ code: "K4", blockers: [], checkerDuties: ["compliance", "compliance_senior"], sponsor: { state: "kyb_review" } });
    expect(JSON.stringify(seen)).not.toMatch(/Zeta Holdings|Testing Avenue/); // sealed values never leave the database
    expect((await detail(comp1, request)).blockers.join(" ")).toMatch(/You requested it/);

    // Maker == checker: the backend (property.decide_request) refuses; the refusal is audited.
    expect(await decide(comp1, request, "approve", seen.digest)).toMatchObject({ ok: false, error: expect.stringMatching(/maker-checker/) as unknown });
    // Not what the officer reviewed.
    expect(await decide(comp2, request, "approve", "00".repeat(32))).toMatchObject({ ok: false, error: expect.stringMatching(/differs/) as unknown });
    // An operations maker has no property.decide permission.
    expect(await pgCode(decide(onb1, request, "approve", seen.digest))).toBe("42501");
    expect(await sponsorState(w.pool, sponsorId)).toBe("kyb_review");

    expect(await decide(comp2, request, "approve", seen.digest)).toEqual({ ok: true, status: "approved" });
    expect(await sponsorState(w.pool, sponsorId)).toBe("kyb_approved");
    const decided = await w.client.query<{ actor: string; action: string }>("SELECT actor, action FROM property.audit WHERE action = 'request.approved' ORDER BY id DESC LIMIT 1");
    expect(decided.rows[0]?.actor).toBe(O.comp2);
    const admin = await w.client.query<{ action: string; detail: { kind: string; result?: string } }>(
      "SELECT action, detail FROM admin.audit WHERE action IN ('approval.decided', 'approval.refused') ORDER BY id",
    );
    expect(admin.rows.map((r) => `${r.action}:${r.detail.kind}`)).toEqual(["approval.refused:property", "approval.refused:property", "approval.decided:property"]);
    expect((await w.client.query("SELECT * FROM admin.verify_audit()")).rows).toEqual([]);
    expect(await verifyAudit(w.pool)).toEqual([]);
  });

  it("a duty needs a portal officer with a matching role; trustee duties only for trustee officers", async () => {
    await refused(w.run("requestDuty", { actor: "not-an-officer", duty: "onboarding", by: O.adm1, reason: "assigned by the operations head" }), "FORBIDDEN", /admin portal/);
    const checker = await officer(w.client, "checker-x", "ops_checker");
    await refused(w.run("requestDuty", { actor: checker.handle, duty: "trustee", by: O.adm1, reason: "seconded to the trustee" }), "FORBIDDEN", /trustee_officer/);
    await refused(w.run("requestDuty", { actor: checker.handle, duty: "onboarding", by: O.adm1, reason: "helping with intake" }), "FORBIDDEN", /ops_maker/);
    await refused(w.run("requestDuty", { actor: O.comp1, duty: "onboarding", by: O.adm1, reason: "helping with intake" }), "FORBIDDEN", /ops_maker/);
    // A due-diligence duty fits any platform officer.
    const id = await w.run("requestDuty", { actor: checker.handle, duty: "technical", by: O.adm1, reason: "building surveyor on the team" });
    expect(await w.run("decideDuty", { dutyId: id, by: O.adm2, approve: true, reason: "checked against the HR record" })).toBe("active");
  });

  it("revoking the role or disabling the officer ends the duty at once", async () => {
    const { request } = await k4Request();
    const comp2 = await officer(w.client, O.comp2, "compliance_officer");
    const has = async (actor: string, duty: string) =>
      (await w.client.query<{ ok: boolean }>("SELECT property.has_duty($1, ARRAY[$2]) AS ok", [actor, duty])).rows[0]?.ok;
    expect(await has(O.comp2, "compliance")).toBe(true);
    await changeOfficer(w.client, "revoke", comp2.id, "compliance_officer");
    expect(await has(O.comp2, "compliance")).toBe(false);
    await refused(w.run("decideRequest", { requestId: BigInt(request), officer: O.comp2, approve: true, reason: "reviewed the file, agree" }), "FORBIDDEN", /needs an active/);

    const senior = await officer(w.client, O.senior, "compliance_officer");
    expect(await has(O.senior, "compliance_senior")).toBe(true);
    await changeOfficer(w.client, "disable", senior.id, null);
    expect(await has(O.senior, "compliance_senior")).toBe(false);
    // A disabled officer's session is gone as well: nothing can be decided in the portal either.
    expect(await pgCode(decide(senior, request, "approve", "00".repeat(32)))).toBe("42501");
  });
});

describe("S-01 maker requests are bound to the portal (migration 0045 PB-1..PB-3)", () => {
  it("an officer's handle cannot ask outside the portal; the portal asks with the officer's session and the duty rules still apply", async () => {
    const s = await draftSponsor(w);
    await w.run("submitKyb", { sponsorId: s.sponsorId, actor: O.onb1, actingFor: s.repId });
    await w.run("screenKyb", { sponsorId: s.sponsorId, actor: O.onb2, accept: true });
    await w.run("recordRegistrationCheck", { sponsorId: s.sponsorId, method: "secp_eservices", outcome: "verified", evidence: hex(), actor: O.onb2 });
    await w.run("recordScreening", { sponsorId: s.sponsorId, provider: "mock-screen", listVersion: "un-2026-10", outcome: "clear", evidence: hex(), actor: O.comp1 });
    await w.run("recordRisk", { sponsorId: s.sponsorId, rating: "low", reasons: "listed group, simple ownership", actor: O.comp1 });
    // Directly under the officer's handle: refused by the binding trigger.
    expect(
      await pgCode(w.client.query("SELECT property.request_transition('sponsor', $1, 'K4', $2, 'all KYB checks complete and clear', '{}'::jsonb)", [s.sponsorId, O.comp1])),
    ).toBe("42501");
    const comp = await officer(w.client, O.comp1, "compliance_officer");
    const options = (await portal.query<{ v: { sponsors: { id: string; codes: string[] | null }[] } }>("SELECT admin.property_request_options($1) AS v", [comp.sessionHash])).rows[0]?.v;
    expect(options?.sponsors.find((x) => x.id === s.sponsorId)?.codes).toEqual(["K4", "K5"]);
    const ok = (await portal.query<{ r: { ok: boolean; id?: number } }>(
      "SELECT admin.request_property_transition($1, 'sponsor', $2, 'K4', 'all KYB checks complete and clear', '{}'::jsonb) AS r",
      [comp.sessionHash, s.sponsorId],
    )).rows[0]?.r;
    expect(ok).toMatchObject({ ok: true });
    const req = await w.client.query<{ requested_by: string }>("SELECT requested_by FROM property.requests WHERE id = $1", [ok?.id]);
    expect(req.rows[0]?.requested_by).toBe(O.comp1);
    // An officer without the duty is refused by the duty rule, with its SQLSTATE.
    const onb = await officer(w.client, O.onb1, "ops_maker");
    const no = (await portal.query<{ r: { ok: boolean; state?: string } }>(
      "SELECT admin.request_property_transition($1, 'sponsor', $2, 'K5', 'not my duty to ask for this', '{}'::jsonb) AS r",
      [onb.sessionHash, s.sponsorId],
    )).rows[0]?.r;
    expect(no).toMatchObject({ ok: false });
  });
});
