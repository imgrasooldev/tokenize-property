import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { normIdentifier, propertyKey } from "../src/normalize.ts";
import { findDuplicates, PropertyError, type PropertyErrorCode, reviewStatus, sponsorOverview, sponsorState, valuationStatus, verifyAudit, workQueue } from "../src/service.ts";
import {
  addDoc,
  approvedSponsor,
  approveSponsor,
  committeeApproves,
  completeDueDiligence,
  currentDoc,
  draftProperty,
  draftSponsor,
  grant,
  hex,
  icClose,
  icVote,
  identifiers,
  makeWorld,
  next,
  O,
  propertyIn,
  startReview,
  stateOf,
  subject,
  submit,
  trusteeAccepts,
  trusteeDecision,
  type Sponsor,
  type World,
} from "./world.ts";

/** S-01 against a real PostgreSQL (migration 0014): state machines, guards, maker-checker, duplicates, PII, audit, roles. */

let w: World;

beforeAll(async () => {
  w = await makeWorld();
}, 120_000);

afterAll(async () => {
  await w.drop();
}, 120_000);

async function refused(p: Promise<unknown>, codes: PropertyErrorCode | PropertyErrorCode[], msg?: RegExp): Promise<void> {
  const list = Array.isArray(codes) ? codes : [codes];
  await expect(p).rejects.toSatisfy((e: unknown) => {
    return e instanceof PropertyError && list.includes(e.code) && (!msg || msg.test(e.message));
  });
}

/** Runs a raw statement as the migration owner, expecting the database to refuse it. */
async function sqlRefused(sql: string, params: unknown[] = []): Promise<string> {
  try {
    await w.client.query(sql, params);
  } catch (e) {
    return (e as { code: string }).code;
  }
  throw new Error(`statement was accepted: ${sql}`);
}

// ------------------------------------------------------------------ the state machines themselves
describe("state machines (PR-2)", () => {
  it("the transitions table is exactly S-01 §3.1 and §3.2", async () => {
    const { rows } = await w.client.query<{ t: string }>("SELECT entity || ':' || code || ':' || from_state || '>' || to_state AS t FROM property.transitions ORDER BY 1");
    const expected = [
      "sponsor:K1:kyb_draft>kyb_submitted",
      "sponsor:K2:kyb_submitted>kyb_review",
      "sponsor:K3:kyb_submitted>kyb_draft",
      "sponsor:K4:kyb_review>kyb_approved",
      "sponsor:K5:kyb_review>kyb_rejected",
      "sponsor:K6:kyb_review>kyb_draft",
      "sponsor:K7:kyb_approved>kyb_expired",
      "sponsor:K8:kyb_approved>kyb_suspended",
      "sponsor:K9:kyb_expired>kyb_review",
      "sponsor:K10:kyb_suspended>kyb_review",
      "sponsor:K11:kyb_suspended>kyb_rejected",
      "property:P1:draft>submitted",
      "property:P2:submitted>draft",
      "property:P3:submitted>rejected",
      "property:P4:submitted>under_review",
      "property:P5:under_review>draft",
      "property:P6:under_review>rejected",
      "property:P7:under_review>legal_approved",
      "property:P8:legal_approved>tokenization_ready",
      "property:P9:legal_approved>under_review",
      "property:P10:tokenization_ready>under_review",
      "property:P11:draft>withdrawn",
      "property:P11:submitted>withdrawn",
      "property:P11:under_review>withdrawn",
      "property:P11:legal_approved>withdrawn",
      "property:P12:under_review>on_hold",
      "property:P12:legal_approved>on_hold",
      "property:P12:tokenization_ready>on_hold",
      "property:P13:on_hold>under_review",
      "property:P14:on_hold>rejected",
    ].sort();
    expect(rows.map((r) => r.t)).toEqual(expected);
  });

  it("an event outside the table, or from another state, is refused even when written directly", async () => {
    const s = await approvedSponsor(w);
    const p = await draftProperty(w, s);
    expect(await sqlRefused("INSERT INTO property.property_events (property_id, code, from_state, to_state, actor) VALUES ($1, 'P7', 'draft', 'legal_approved', 'x-admin')", [p])).toBe("23514");
    expect(await sqlRefused("INSERT INTO property.property_events (property_id, code, from_state, to_state, actor) VALUES ($1, 'P8', 'legal_approved', 'tokenization_ready', 'x-admin')", [p])).toBe(
      "23514",
    );
    expect(await sqlRefused("UPDATE property.properties SET state = 'tokenization_ready' WHERE id = $1", [p])).toBe("23514");
    expect(await sqlRefused("UPDATE property.sponsors SET state = 'kyb_rejected' WHERE id = (SELECT sponsor_id FROM property.properties WHERE id = $1)", [p])).toBe("23514");
    expect(await stateOf(w, p)).toBe("draft");
  });

  const STATES = ["draft", "submitted", "under_review", "legal_approved", "tokenization_ready", "on_hold", "rejected", "withdrawn"];
  const ALLOWED = new Map<string, string[]>([
    ["P1", ["draft"]],
    ["P2", ["submitted"]],
    ["P4", ["submitted"]],
    ["P5", ["under_review"]],
    ["P11", ["draft", "submitted", "under_review", "legal_approved"]],
    ["P12", ["under_review", "legal_approved", "tokenization_ready"]],
    ["P13", ["on_hold"]],
    ["P14", ["on_hold"]],
    ["P7", ["under_review"]],
    ["P8", ["legal_approved"]],
  ]);

  it("every transition is refused from every state it does not start from, and the state does not move", async () => {
    const s = await approvedSponsor(w);
    for (const state of STATES) {
      const p = await propertyIn(w, s, state);
      expect(await stateOf(w, p)).toBe(state);
      const ops: Record<string, () => Promise<unknown>> = {
        P1: () => submit(w, s, p),
        P2: () => w.run("returnProperty", { propertyId: p, officer: O.onb2, reason: "missing the rent roll" }),
        P4: () => w.run("startReview", { propertyId: p, officer: O.onb2, legal: O.legal1, valuation: O.val1, technical: O.tech1 }),
        P5: () => w.run("queryProperty", { propertyId: p, reviewer: O.legal1, query: "please send the 2010 mutation" }),
        P11: () => w.run("withdrawProperty", { propertyId: p, actor: O.onb1, actingFor: s.repId, reason: "sponsor decided not to proceed" }),
        P12: () => w.run("holdProperty", { propertyId: p, actor: O.legal1, reason: "stay order served on the parcel" }),
        P13: () => w.run("requestTransition", { entity: "property", id: p, code: "P13", officer: O.legal1, reason: "stay order was vacated", detail: { evidence: hex() } }),
        P14: () => w.run("requestTransition", { entity: "property", id: p, code: "P14", officer: O.legal1, reason: "stay order confirmed", detail: { curable: false } }),
        P7: () => w.run("openIc", { propertyId: p, chair: O.ic1 }),
        P8: () => trusteeAccepts(w, s, p),
      };
      for (const [code, op] of Object.entries(ops)) {
        if ((ALLOWED.get(code) ?? []).includes(state)) continue;
        await refused(op(), ["GUARD", "FORBIDDEN"]);
        expect(await stateOf(w, p), `${code} from ${state}`).toBe(state);
      }
    }
  }, 300_000);
});

// ------------------------------------------------------------------ KYB
describe("sponsor KYB (S-01 §3.1)", () => {
  it("K1..K4: an approved sponsor reads as approved for 365 days; overview has no hashes or sealed values", async () => {
    const s = await approvedSponsor(w);
    const o = await sponsorOverview(w.pool, s.sponsorId);
    expect(o).toMatchObject({ kind: "company", state: "kyb_approved", cuinLast4: s.cuin.slice(-4) });
    const days = ((o?.kybValidUntil?.getTime() ?? 0) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(364);
    expect(days).toBeLessThan(366);
    expect(JSON.stringify(o)).not.toMatch(/enc|hash/i);
    expect(await w.svc.sponsorDetails(s.sponsorId)).toEqual({ kind: "company", legalName: s.legalName, address: s.address });
    expect(await w.svc.findSponsor("cuin", ` ${s.cuin.slice(0, 3)}-${s.cuin.slice(3)} `)).toBe(s.sponsorId);
    await refused(w.svc.createSponsor({ kind: "company", legalName: "Another Name Ltd", address: "Somewhere in Karachi", cuin: s.cuin, actor: O.onb1 }), "DUPLICATE");
  });

  it("K1 needs the documents, the people and a representative with the submit power", async () => {
    const s = await draftSponsor(w);
    const noPower = await subject(w);
    const weakRep = (await w.run("addPerson", { sponsorId: s.sponsorId, subjectId: noPower.id, role: "representative", powers: ["upload"], actor: O.onb1 })).toString();
    await refused(w.run("submitKyb", { sponsorId: s.sponsorId, actor: O.onb1, actingFor: weakRep }), "FORBIDDEN", /submit power/);
    await refused(w.run("submitKyb", { sponsorId: s.sponsorId, actor: O.legal1, actingFor: s.repId }), "FORBIDDEN");
    const bare = await w.svc.createSponsor({ kind: "company", legalName: "Bare Shell Ltd", address: "Plot 1, Nowhere Road", cuin: `99${String(next())}`, actor: O.onb1 });
    const rep = await subject(w);
    const repId = (await w.run("addPerson", { sponsorId: bare, subjectId: rep.id, role: "representative", powers: ["submit"], actor: O.onb1 })).toString();
    await refused(w.run("submitKyb", { sponsorId: bare, actor: O.onb1, actingFor: repId }), "GUARD", /director/);
    await w.run("addPerson", { sponsorId: bare, subjectId: rep.id, role: "director", actor: O.onb1 });
    await refused(w.run("addPerson", { sponsorId: bare, subjectId: rep.id, role: "beneficial_owner", ownershipBp: 1000, control: "shares", actor: O.onb1 }), "INVALID_INPUT", /threshold/);
    await w.run("addPerson", { sponsorId: bare, subjectId: rep.id, role: "beneficial_owner", ownershipBp: 2500, control: "shares", actor: O.onb1 });
    await refused(w.run("submitKyb", { sponsorId: bare, actor: O.onb1, actingFor: repId }), "GUARD", /missing KYB documents/);
  });

  it("K2/K3: the officer who submitted never accepts; return needs a reason; K6 sends a query back to draft", async () => {
    const s = await draftSponsor(w);
    await w.run("submitKyb", { sponsorId: s.sponsorId, actor: O.onb1, actingFor: s.repId });
    await refused(w.run("screenKyb", { sponsorId: s.sponsorId, actor: O.onb1, accept: true }), "FORBIDDEN", /OB-SOD-1/);
    await refused(w.run("screenKyb", { sponsorId: s.sponsorId, actor: O.onb2, accept: false }), "INVALID_INPUT");
    expect(await w.run("screenKyb", { sponsorId: s.sponsorId, actor: O.onb2, accept: false, reason: "board resolution unsigned" })).toBe("kyb_draft");
    await w.run("submitKyb", { sponsorId: s.sponsorId, actor: O.onb1, actingFor: s.repId });
    expect(await w.run("screenKyb", { sponsorId: s.sponsorId, actor: O.onb2, accept: true })).toBe("kyb_review");
    await refused(w.run("queryKyb", { sponsorId: s.sponsorId, actor: O.onb2, query: "who controls the trust?" }), "FORBIDDEN");
    expect(await w.run("queryKyb", { sponsorId: s.sponsorId, actor: O.comp1, query: "who controls the family trust shareholder?" })).toBe("kyb_draft");
  });

  it("K4 needs every person KYC-verified, SECP verification, a clear screening and a risk rating", async () => {
    const s = await draftSponsor(w);
    const pending = await subject(w, 9); // NADRA unavailable: stays pending
    await w.run("addPerson", { sponsorId: s.sponsorId, subjectId: pending.id, role: "director", actor: O.onb1 });
    await w.run("submitKyb", { sponsorId: s.sponsorId, actor: O.onb1, actingFor: s.repId });
    await w.run("screenKyb", { sponsorId: s.sponsorId, actor: O.onb2, accept: true });
    const k4 = () => w.run("requestTransition", { entity: "sponsor", id: s.sponsorId, code: "K4", officer: O.comp1, reason: "all KYB checks complete and clear" });
    await refused(k4(), "GUARD", /SECP/);
    await w.run("recordRegistrationCheck", { sponsorId: s.sponsorId, method: "manual", outcome: "verified", evidence: hex(), actor: O.onb2 });
    await refused(k4(), "GUARD", /screening/);
    await w.run("recordScreening", { sponsorId: s.sponsorId, provider: "mock-screen", listVersion: "un-2026-10", outcome: "clear", evidence: hex(), actor: O.comp1 });
    await refused(k4(), "GUARD", /risk rating/);
    await w.run("recordRisk", { sponsorId: s.sponsorId, rating: "medium", reasons: "new company, two shareholders", actor: O.comp1 });
    await refused(k4(), "GUARD", /not KYC-verified/);
    const { rows } = await w.client.query<{ id: string }>("SELECT id FROM property.sponsor_persons WHERE sponsor_id = $1 AND subject_id = $2", [s.sponsorId, pending.id]);
    await w.run("endPerson", { personId: rows[0]?.id ?? "0", actor: O.comp1, reason: "director resigned, form 29 filed" });
    expect(typeof (await k4())).toBe("bigint");
  });

  it("K4 is maker-checker: the requester never approves, one rejection is final, high risk needs a senior checker", async () => {
    const s = await draftSponsor(w);
    await w.run("submitKyb", { sponsorId: s.sponsorId, actor: O.onb1, actingFor: s.repId });
    await w.run("screenKyb", { sponsorId: s.sponsorId, actor: O.onb2, accept: true });
    await w.run("recordRegistrationCheck", { sponsorId: s.sponsorId, method: "secp_eservices", outcome: "verified", evidence: hex(), actor: O.onb2 });
    await w.run("recordScreening", { sponsorId: s.sponsorId, provider: "mock-screen", listVersion: "un-2026-10", outcome: "clear", evidence: hex(), actor: O.comp1 });
    await refused(w.run("recordRisk", { sponsorId: s.sponsorId, rating: "high", reasons: "complex offshore ownership", actor: O.comp1 }), "INVALID_INPUT", /enhanced due diligence/);
    await w.run("recordRisk", { sponsorId: s.sponsorId, rating: "high", reasons: "complex offshore ownership", edd: hex(), actor: O.comp1 });
    const r1 = await w.run("requestTransition", { entity: "sponsor", id: s.sponsorId, code: "K4", officer: O.comp1, reason: "EDD complete, sources of wealth documented" });
    await refused(w.run("decideRequest", { requestId: r1, officer: O.comp1, approve: true, reason: "approving my own request" }), "FORBIDDEN", /maker-checker/);
    await refused(w.run("decideRequest", { requestId: r1, officer: O.comp2, approve: true, reason: "looks fine to me overall" }), "FORBIDDEN", /compliance_senior/);
    await refused(w.run("requestTransition", { entity: "sponsor", id: s.sponsorId, code: "K4", officer: O.comp2, reason: "second request in parallel" }), "DUPLICATE");
    expect(await w.run("decideRequest", { requestId: r1, officer: O.senior, approve: false, reason: "source of wealth letter unsigned" })).toBe("rejected");
    await refused(w.run("decideRequest", { requestId: r1, officer: O.comp2, approve: true, reason: "overriding the rejection" }), "GUARD", /already rejected/);
    expect(await sponsorState(w.pool, s.sponsorId)).toBe("kyb_review");
    const r2 = await w.run("requestTransition", { entity: "sponsor", id: s.sponsorId, code: "K4", officer: O.comp2, reason: "signed letter received and checked" });
    expect(await w.run("decideRequest", { requestId: r2, officer: O.senior, approve: true, reason: "EDD evidence is now complete" })).toBe("approved");
    expect(await sponsorState(w.pool, s.sponsorId)).toBe("kyb_approved");
    const { rows } = await w.client.query<{ actor: string; checker: string }>("SELECT actor, checker FROM property.sponsor_events WHERE sponsor_id = $1 AND code = 'K4'", [s.sponsorId]);
    expect(rows).toEqual([{ actor: O.senior, checker: O.comp2 }]);
  });

  it("K5 needs an FMU assessment first (never in the audit detail); a possible screening match needs two officers to clear", async () => {
    const s = await draftSponsor(w);
    await w.run("submitKyb", { sponsorId: s.sponsorId, actor: O.onb1, actingFor: s.repId });
    await w.run("screenKyb", { sponsorId: s.sponsorId, actor: O.onb2, accept: true });
    const scr = await w.run("recordScreening", { sponsorId: s.sponsorId, provider: "mock-screen", listVersion: "un-2026-10", outcome: "possible_match", evidence: hex(), actor: O.comp1 });
    const sc = await w.run("requestTransition", { entity: "sponsor", id: s.sponsorId, code: "SC", officer: O.comp1, reason: "different incorporation date and directors", detail: { screening: Number(scr), evidence: hex() } });
    await refused(w.run("decideRequest", { requestId: sc, officer: O.comp1, approve: true, reason: "self approval attempt" }), "FORBIDDEN");
    await w.run("decideRequest", { requestId: sc, officer: O.comp2, approve: true, reason: "agree, false positive on the name" });
    const { rows } = await w.client.query<{ outcome: string; basis: string }>("SELECT outcome, basis FROM property.sponsor_screenings WHERE sponsor_id = $1 ORDER BY id DESC LIMIT 1", [s.sponsorId]);
    expect(rows[0]).toEqual({ outcome: "clear", basis: "cleared_false_positive" });
    const k5 = () => w.run("requestTransition", { entity: "sponsor", id: s.sponsorId, code: "K5", officer: O.comp1, reason: "beneficial owner refused to identify" });
    await refused(k5(), "GUARD", /FMU/);
    await w.run("recordFmu", { sponsorId: s.sponsorId, outcome: "str_filed", evidence: hex(), actor: O.comp1 });
    const r = await k5();
    await w.run("decideRequest", { requestId: r, officer: O.comp2, approve: true, reason: "agree, refusal is a red flag" });
    expect(await sponsorState(w.pool, s.sponsorId)).toBe("kyb_rejected");
    const audit = await w.client.query<{ d: string }>("SELECT detail::text AS d FROM property.audit WHERE action = 'sponsor.fmu_assessed'");
    for (const a of audit.rows) expect(a.d).not.toMatch(/str_filed|no_grounds/);
    const p = await w.run("createProperty", { sponsorId: s.sponsorId, actor: O.onb1, actingFor: s.repId, identifiers: {} }).catch((e: unknown) => e);
    expect(p).toBeInstanceOf(PropertyError);
  });

  it("K7 is derived when a person loses KYC; K9 refresh; K8 suspends and holds the sponsor's files; K10 and K11", async () => {
    const s = await draftSponsor(w);
    const rep2 = await subject(w);
    const rep2Id = (await w.run("addPerson", { sponsorId: s.sponsorId, subjectId: rep2.id, role: "representative", powers: ["submit", "upload", "respond", "withdraw"], actor: O.onb1 })).toString();
    await w.run("addPerson", { sponsorId: s.sponsorId, subjectId: rep2.id, role: "director", actor: O.onb1 });
    await approveSponsor(w, s);
    const p = await propertyIn(w, s, "under_review");
    await w.client.query("SELECT kyc.revoke($1, 'kyc-officer-1', 'identity document reported stolen')", [s.rep.id]);
    expect(await sponsorState(w.pool, s.sponsorId)).toBe("kyb_expired");
    const draft = await draftProperty(w, s, {}, {}).catch(() => null);
    expect(draft).toBeNull(); // the revoked representative can no longer act
    expect(await w.run("expireSponsors", { actor: "system:kyb-expiry" })).toBeGreaterThanOrEqual(1);
    const { rows } = await w.client.query<{ code: string }>("SELECT code FROM property.sponsor_events WHERE sponsor_id = $1 ORDER BY id DESC LIMIT 1", [s.sponsorId]);
    expect(rows[0]?.code).toBe("K7");
    await refused(w.run("submitKyb", { sponsorId: s.sponsorId, actor: O.onb1, actingFor: s.repId }), "FORBIDDEN", /not KYC-verified/);
    const { rows: rp } = await w.client.query<{ id: string }>("SELECT id FROM property.sponsor_persons WHERE sponsor_id = $1 AND subject_id = $2", [s.sponsorId, s.rep.id]);
    for (const r of rp) await w.run("endPerson", { personId: r.id, actor: O.onb2, reason: "authority withdrawn by the board" });
    expect(await w.run("submitKyb", { sponsorId: s.sponsorId, actor: O.onb1, actingFor: rep2Id })).toBe("kyb_review");
    const k4 = await w.run("requestTransition", { entity: "sponsor", id: s.sponsorId, code: "K4", officer: O.comp1, reason: "refreshed file checked again" });
    await w.run("decideRequest", { requestId: k4, officer: O.comp2, approve: true, reason: "agree with the refresh" });
    expect(await sponsorState(w.pool, s.sponsorId)).toBe("kyb_approved");
    // K8: adverse finding holds every file under review (P12).
    expect(await w.run("suspendSponsor", { sponsorId: s.sponsorId, actor: O.comp1, reason: "court order freezing the company's assets" })).toBe(1);
    expect(await stateOf(w, p)).toBe("on_hold");
    const k10 = await w.run("requestTransition", { entity: "sponsor", id: s.sponsorId, code: "K10", officer: O.comp1, reason: "court order set aside on appeal" });
    await refused(w.run("decideRequest", { requestId: k10, officer: O.onb2, approve: true, reason: "onboarding cannot decide" }), "FORBIDDEN");
    await w.run("decideRequest", { requestId: k10, officer: O.comp2, approve: true, reason: "appeal judgment verified" });
    expect(await sponsorState(w.pool, s.sponsorId)).toBe("kyb_review");
    // K11 on another sponsor: a company list hit suspends an approved sponsor at once.
    const t = await approvedSponsor(w);
    await w.run("recordScreening", { sponsorId: t.sponsorId, provider: "mock-screen", listVersion: "un-2026-11", outcome: "hit", evidence: hex(), actor: O.comp1 });
    expect(await sponsorState(w.pool, t.sponsorId)).toBe("kyb_suspended");
    await w.run("recordFmu", { sponsorId: t.sponsorId, outcome: "str_filed", evidence: hex(), actor: O.comp2 });
    const k11 = await w.run("requestTransition", { entity: "sponsor", id: t.sponsorId, code: "K11", officer: O.comp2, reason: "confirmed match on the UN list" });
    await w.run("decideRequest", { requestId: k11, officer: O.senior, approve: true, reason: "confirmed by the list provider" });
    expect(await sponsorState(w.pool, t.sponsorId)).toBe("kyb_rejected");
  }, 120_000);
});

// ------------------------------------------------------------------ property workflow
describe("property submission and review (S-01 §3.2)", () => {
  let s: Sponsor;
  beforeAll(async () => {
    s = await approvedSponsor(w);
  }, 60_000);

  it("P1 needs complete identifiers, every mandatory document and an approved sponsor", async () => {
    const p = await w.run("createProperty", { sponsorId: s.sponsorId, actor: O.onb1, actingFor: s.repId, identifiers: identifiers(next(), { excise_no: null, occupancy: "tenanted" }) });
    await refused(submit(w, s, p), "GUARD", /identifiers incomplete.*property-tax number.*leases summary/);
    await refused(w.run("updateProperty", { propertyId: p, actor: O.onb1, actingFor: s.repId, identifiers: { state: "submitted" } as never }), "INVALID_INPUT");
    await w.run("updateProperty", { propertyId: p, actor: O.onb1, actingFor: s.repId, identifiers: { excise_no: `EX-${String(next())}`, lease_count: 2, monthly_rent_paisa: "45000000" } });
    await refused(submit(w, s, p), "GUARD", /missing mandatory documents.*lease_agreement.*title_deed/);
    const draftSponsorOnly = await draftSponsor(w);
    const q = await w.run("createProperty", { sponsorId: draftSponsorOnly.sponsorId, actor: O.onb1, actingFor: draftSponsorOnly.repId, identifiers: identifiers() });
    await refused(submit(w, draftSponsorOnly, q), "GUARD", /not KYB-approved/);
  });

  it("documents: same bytes once, superseded never overwritten, store reference opaque, type matches the file", async () => {
    const p = await draftProperty(w, s);
    const sha = hex();
    const a = await addDoc(w, { sponsorId: s.sponsorId, propertyId: p, docType: "rent_roll", actor: O.onb1, actingFor: s.repId, sha });
    expect(await addDoc(w, { sponsorId: s.sponsorId, propertyId: p, docType: "rent_roll", actor: O.onb1, actingFor: s.repId, sha })).toBe(a);
    await refused(addDoc(w, { sponsorId: s.sponsorId, propertyId: p, docType: "utility_bill", actor: O.onb1, actingFor: s.repId, sha }), "DUPLICATE");
    await refused(addDoc(w, { sponsorId: s.sponsorId, docType: "rent_roll", actor: O.onb1, actingFor: s.repId }), "INVALID_INPUT");
    await refused(
      w.run("addDocument", { sponsorId: s.sponsorId, propertyId: p, docType: "rent_roll", sha256: hex(), sizeBytes: 10, mediaType: "application/pdf", storeRef: "vault://Ali Khan CNIC.pdf", actor: O.onb1, actingFor: s.repId }),
      "INVALID_INPUT",
    );
    const b = await addDoc(w, { sponsorId: s.sponsorId, propertyId: p, docType: "rent_roll", actor: O.onb1, actingFor: s.repId, supersedes: a });
    await refused(addDoc(w, { sponsorId: s.sponsorId, propertyId: p, docType: "rent_roll", actor: O.onb1, actingFor: s.repId, supersedes: a }), "DUPLICATE", /already superseded/);
    const { rows } = await w.client.query<{ document_id: string; current: boolean; superseded_by: string | null }>(
      "SELECT document_id, current, superseded_by FROM property.document_list WHERE document_id = ANY ($1) ORDER BY uploaded_at",
      [[a, b]],
    );
    expect(rows).toEqual([
      { document_id: a, current: false, superseded_by: b },
      { document_id: b, current: true, superseded_by: null },
    ]);
    expect(await sqlRefused("UPDATE property.documents SET sha256 = sha256 WHERE id = $1", [a])).toBe("42501");
  });

  it("P2, P4 and P5: separation of duties for the officer and the three reviewers", async () => {
    const p = await draftProperty(w, s);
    await submit(w, s, p);
    await refused(w.run("returnProperty", { propertyId: p, officer: O.onb1, reason: "returning my own submission" }), "FORBIDDEN", /OB-SOD-1/);
    expect(await w.run("returnProperty", { propertyId: p, officer: O.onb2, reason: "fard is older than 30 days" })).toBe("draft");
    await submit(w, s, p);
    await refused(w.run("startReview", { propertyId: p, officer: O.onb2, legal: O.legal1, valuation: O.legal1, technical: O.tech1 }), "FORBIDDEN");
    await refused(w.run("startReview", { propertyId: p, officer: O.onb2, legal: O.legal1, valuation: O.val1, technical: O.legal2 }), "FORBIDDEN", /technical/);
    await refused(w.run("startReview", { propertyId: p, officer: O.onb1, legal: O.legal1, valuation: O.val1, technical: O.tech1 }), "FORBIDDEN", /OB-SOD-1/);
    await grant(w, "multi-1", "onboarding");
    await grant(w, "multi-1", "legal");
    await refused(w.run("startReview", { propertyId: p, officer: "multi-1", legal: "multi-1", valuation: O.val1, technical: O.tech1 }), "FORBIDDEN", /assigns reviewers/);
    expect(await startReview(w, p)).toBe("under_review");
    await refused(w.run("queryProperty", { propertyId: p, reviewer: O.legal2, query: "not my file but asking anyway" }), "FORBIDDEN");
    expect(await w.run("queryProperty", { propertyId: p, reviewer: O.val1, query: "please share the rent escalation clause" })).toBe("draft");
  });

  it("a review relies only on current documents; a pass needs its discipline's rules (OB-20, OB-21, OB-22, OB-26, OB-28, OB-30)", async () => {
    const p = await propertyIn(w, s, "under_review");
    const title = (await currentDoc(w, p, "title_deed")) ?? "";
    const review = (discipline: "title" | "encumbrance" | "technical", reviewer: string, documents: string[], decision: "pass" | "fail" = "pass") =>
      w.run("recordReview", { propertyId: p, reviewer, discipline, scope: "full scope review", method: "documents checked", findings: "see the attached memo", decision, documents });
    await refused(review("title", O.legal2, [title]), "FORBIDDEN", /assigned legal reviewer/);
    await refused(review("title", O.legal1, [title]), "GUARD", /verified at its source/);
    await w.run("verifyDocument", { documentId: title, actor: O.legal1, method: "online_portal", office: "PLRA Lahore", verifiedOn: "2026-10-02", outcome: "verified", evidence: hex() });
    await refused(review("title", O.legal1, [title]), "GUARD", /no chain of title/);
    await w.run("addTitleLink", { propertyId: p, actor: O.legal1, position: 1, kind: "sale_deed", instrumentRef: "D-77", registeredOn: "2015-03-01", documentId: title });
    await refused(review("title", O.legal1, [title]), "GUARD", /search period/);
    const enc = await w.run("recordEncumbrance", { propertyId: p, actor: O.legal1, kind: "mortgage", description: "registered mortgage in favour of a bank", evidence: hex() });
    const search = await addDoc(w, { sponsorId: s.sponsorId, propertyId: p, docType: "encumbrance_search", actor: O.legal1 });
    await refused(review("encumbrance", O.legal1, [search]), "GUARD", /OB-22/);
    await w.run("resolveEncumbrance", { encumbranceId: enc, actor: O.legal1, resolution: "condition_precedent", note: "to be redeemed from the offering proceeds", evidence: hex() });
    expect(typeof (await review("encumbrance", O.legal1, [search]))).toBe("bigint");
    await refused(review("technical", O.tech1, [title]), "GUARD", /technical report/);
    const old = await addDoc(w, { sponsorId: s.sponsorId, propertyId: p, docType: "technical_report", actor: O.tech1 });
    await addDoc(w, { sponsorId: s.sponsorId, propertyId: p, docType: "technical_report", actor: O.tech1, supersedes: old });
    await refused(review("technical", O.tech1, [old]), "INVALID_INPUT", /current documents/);
  });

  it("valuations: the panel only, exactly 10 % passes, beyond needs a third; the offering cap is the lowest (OB-25, OB-26)", async () => {
    const p = await propertyIn(w, s, "under_review");
    const report = () => addDoc(w, { sponsorId: s.sponsorId, propertyId: p, docType: "valuation_report", actor: O.val1 });
    const today = new Date().toISOString().slice(0, 10);
    const value = async (valuerId: string, valuePaisa: bigint, actor: string = O.val1) =>
      w.run("recordValuation", { propertyId: p, actor, valuerId, valuePaisa, valuedOn: today, reportId: await report(), independence: hex() });
    const unapproved = await w.run("addValuer", { licence: `PBA/${String(next())}`, panel: "pba", actor: O.adm1 });
    await refused(w.run("approveValuer", { valuerId: unapproved, actor: O.adm1 }), "FORBIDDEN");
    await refused(value(unapproved.toString(), 1n), "FORBIDDEN", /panel/);
    await refused(value(w.valuers[0], 10_000_000_000n, O.val2), "FORBIDDEN", /assigned valuation reviewer/);
    await value(w.valuers[0], 10_000_000_000n);
    expect(await valuationStatus(w.pool, p)).toMatchObject({ ok: false, valuations: 1 });
    await value(w.valuers[1], 11_000_000_001n);
    expect((await valuationStatus(w.pool, p)).problem).toMatch(/third valuation/);
    await value(w.valuers[1], 11_000_000_000n); // a revised report: exactly 10 % above the lower
    expect(await valuationStatus(w.pool, p)).toEqual({ ok: true, problem: null, valuations: 2, lowestPaisa: 10_000_000_000n });
    await value(w.valuers[1], 13_000_000_000n);
    expect((await valuationStatus(w.pool, p)).ok).toBe(false);
    await value(w.valuers[2], 9_500_000_000n);
    expect(await valuationStatus(w.pool, p)).toEqual({ ok: true, problem: null, valuations: 3, lowestPaisa: 9_500_000_000n });
    const { rows } = await w.client.query<{ c: string }>("SELECT property.offering_value_cap($1)::text AS c", [p]);
    expect(rows[0]?.c).toBe("9500000000");
  });

  it("valuer independence: a person of the sponsor cannot value its property (OB-SOD-3)", async () => {
    const p = await propertyIn(w, s, "under_review");
    const v = await w.run("addValuer", { licence: `PBA/${String(next())}`, panel: "pba", subjectId: s.bo.id, actor: O.adm1 });
    await w.run("approveValuer", { valuerId: v, actor: O.adm2 });
    const reportId = await addDoc(w, { sponsorId: s.sponsorId, propertyId: p, docType: "valuation_report", actor: O.val1 });
    await refused(
      w.run("recordValuation", { propertyId: p, actor: O.val1, valuerId: v, valuePaisa: 1n, valuedOn: "2026-10-01", reportId, independence: hex() }),
      "FORBIDDEN",
      /person of the sponsor/,
    );
  });

  it("P7: the committee needs a quorum with an independent member; parties and conflicted members do not count", async () => {
    const p = await propertyIn(w, s, "under_review");
    await refused(w.run("openIc", { propertyId: p, chair: O.ic1 }), "GUARD", /no title review/);
    await completeDueDiligence(w, s, p);
    await refused(w.run("openIc", { propertyId: p, chair: O.legal1 }), "FORBIDDEN");
    const m = await w.run("openIc", { propertyId: p, chair: O.ic1 });
    // Migration 0026 (V-2): votes under an officer's handle are cast in the portal only.
    await refused(w.run("castVote", { meetingId: m, member: O.ic1, vote: "approve" }), "FORBIDDEN", /officer of the admin portal/);
    await icVote(w, O.ic1, m, "approve");
    await icVote(w, O.ic2, m, "approve");
    await icVote(w, O.ic4, m, "conflict", "my brother-in-law is a director of the sponsor");
    await refused(icVote(w, O.ic2, m, "reject"), "DUPLICATE");
    await refused(icVote(w, O.legal1, m, "approve"), "FORBIDDEN");
    await refused(icClose(w, O.ic1, m), "GUARD", /quorum/);
    await refused(icClose(w, O.ic2, m), "FORBIDDEN");
    await icVote(w, O.ic3, m, "reject");
    await refused(w.run("closeIc", { meetingId: m, chair: O.ic1, minutes: hex() }), "FORBIDDEN", /officer of the admin portal/);
    expect(await icClose(w, O.ic1, m)).toBe("not_approved");
    expect(await stateOf(w, p)).toBe("under_review");
    expect(await committeeApproves(w, p)).toBe("legal_approved");
    expect(await verifyAudit(w.pool)).toEqual([]);
  });

  it("P8: only a trustee officer accepts; a trustee holds no other duty; a Shariah structure needs its certificate", async () => {
    await refused(w.run("requestDuty", { actor: O.trustee, duty: "legal", by: O.adm1, reason: "also helping the legal team" }), "FORBIDDEN", /trustee/);
    await refused(w.run("requestDuty", { actor: O.legal1, duty: "trustee", by: O.adm1, reason: "seconded to the trustee" }), "FORBIDDEN");
    const p = await propertyIn(w, s, "legal_approved");
    await refused(trusteeAccepts(w, s, p, O.legalHead), "FORBIDDEN", /trustee/);
    const deed = (await currentDoc(w, p, "trust_deed")) ?? "";
    const sid = await w.run("recordStructure", {
      propertyId: p,
      actor: O.legalHead,
      kind: "reit",
      shariah: true,
      unitRights: { income: "Ijarah rent pro rata", exit: "pro rata", voting: "sale needs 75 %", information: "quarterly" },
      plannedUnits: "1000000",
      trustDeedId: deed,
    });
    await refused(trusteeDecision(w, O.trustee, p, true, sid.toString(), "accepting the Shariah REIT"), "GUARD", /Shariah certificate/);
    // Migration 0026 (V-2): the trustee decides in the portal only.
    await refused(w.run("trusteeDecide", { propertyId: p, trustee: O.trustee, structureId: sid, accept: false, reason: "waiting for the Shariah adviser" }), "FORBIDDEN", /admin portal/);
    expect(await trusteeDecision(w, O.trustee, p, false, sid.toString(), "waiting for the Shariah adviser")).toBe("legal_approved");
    // V-4: a decision on a structure is final; a new structure decision is needed.
    await refused(trusteeDecision(w, O.trustee, p, true, sid.toString(), "accepting after all"), "GUARD", /already decided/);
    const { rows } = await w.client.query<{ max_holding_units: string }>("SELECT max_holding_units::text FROM property.structures WHERE id = $1", [sid]);
    expect(rows[0]?.max_holding_units).toBe("100000");
    expect(await trusteeAccepts(w, s, p)).toBe("tokenization_ready");
  });

  it("a superseded document or a new encumbrance reopens the reviews and moves an approved file back (P9, P10, OB-31, OB-39)", async () => {
    const a = await propertyIn(w, s, "legal_approved");
    const title = (await currentDoc(w, a, "title_deed")) ?? "";
    await addDoc(w, { sponsorId: s.sponsorId, propertyId: a, docType: "title_deed", actor: O.legal1, supersedes: title });
    expect(await stateOf(w, a)).toBe("under_review");
    const st = await reviewStatus(w.pool, a);
    expect(st.find((x) => x.discipline === "title")?.fresh).toBe(false);
    expect(st.find((x) => x.discipline === "technical")?.fresh).toBe(true);
    await refused(w.run("openIc", { propertyId: a, chair: O.ic1 }), "GUARD", /title review was reopened/);
    await completeDueDiligence(w, s, a);
    expect(await committeeApproves(w, a)).toBe("legal_approved");
    expect(await trusteeAccepts(w, s, a)).toBe("tokenization_ready");
    await w.run("recordEncumbrance", { propertyId: a, actor: O.legal1, kind: "litigation", description: "suit for specific performance filed", evidence: hex() });
    expect(await stateOf(w, a)).toBe("under_review");
    const { rows } = await w.client.query<{ code: string }>("SELECT code FROM property.property_events WHERE property_id = $1 ORDER BY id DESC LIMIT 1", [a]);
    expect(rows[0]?.code).toBe("P10");
    expect(await w.run("reopen", { propertyId: a, actor: O.tech1, disciplines: ["technical"], reason: "roof leak reported by the tenant" })).toBe("under_review");
  });

  it("P6 is maker-checker: the reviewer's failed review, then a second reviewer of the discipline or the legal head", async () => {
    const p = await propertyIn(w, s, "under_review");
    const rep = await addDoc(w, { sponsorId: s.sponsorId, propertyId: p, docType: "technical_report", actor: O.tech1 });
    const p6 = () => w.run("requestTransition", { entity: "property", id: p, code: "P6", officer: O.tech1, reason: "unsafe structure, no completion certificate", detail: { discipline: "technical", curable: true } });
    await refused(p6(), "GUARD", /failed review/);
    await w.run("recordReview", {
      propertyId: p,
      reviewer: O.tech1,
      discipline: "technical",
      scope: "structure and approvals",
      method: "site visit and drawings",
      findings: "two floors built without approval",
      decision: "fail",
      documents: [rep],
    });
    const r = await p6();
    await refused(w.run("decideRequest", { requestId: r, officer: O.tech1, approve: true, reason: "approving my own finding" }), "FORBIDDEN");
    await refused(w.run("decideRequest", { requestId: r, officer: O.val2, approve: true, reason: "valuation agrees with tech" }), "FORBIDDEN", /same discipline/);
    expect(await w.run("decideRequest", { requestId: r, officer: O.tech2, approve: true, reason: "confirmed on a second visit" })).toBe("approved");
    expect(await stateOf(w, p)).toBe("rejected");
    // OB-16: a curable rejection allows one new linked file of the same sponsor.
    const other = await approvedSponsor(w);
    await refused(w.run("createProperty", { sponsorId: other.sponsorId, actor: O.onb1, actingFor: other.repId, previousId: p, identifiers: {} }), "GUARD", /OB-16/);
    const again = await w.run("createProperty", { sponsorId: s.sponsorId, actor: O.onb1, actingFor: s.repId, previousId: p, identifiers: {} });
    await refused(w.run("createProperty", { sponsorId: s.sponsorId, actor: O.onb1, actingFor: s.repId, previousId: p, identifiers: {} }), "DUPLICATE");
    expect(again).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("P12..P14: hold by legal or compliance; resume with evidence and reject need the legal head as checker", async () => {
    const p = await propertyIn(w, s, "tokenization_ready");
    await refused(w.run("holdProperty", { propertyId: p, actor: O.val1, reason: "valuer thinks there is a dispute" }), "FORBIDDEN");
    await w.run("holdProperty", { propertyId: p, actor: O.comp1, reason: "fraud indicator raised by the bank" });
    await refused(w.run("requestTransition", { entity: "property", id: p, code: "P13", officer: O.legal1, reason: "indicator closed after the review" }), "INVALID_INPUT", /evidence/);
    const r = await w.run("requestTransition", { entity: "property", id: p, code: "P13", officer: O.legal1, reason: "indicator closed after the review", detail: { evidence: hex() } });
    await refused(w.run("decideRequest", { requestId: r, officer: O.legal2, approve: true, reason: "a plain legal reviewer agrees" }), "FORBIDDEN", /legal_head/);
    await w.run("decideRequest", { requestId: r, officer: O.legalHead, approve: true, reason: "bank letter closes the indicator" });
    expect(await stateOf(w, p)).toBe("under_review");
    // P12 from legal_approved and P11 from legal_approved.
    const q = await propertyIn(w, s, "legal_approved");
    await w.run("holdProperty", { propertyId: q, actor: O.legal1, reason: "lis pendens registered on the title" });
    const q2 = await propertyIn(w, s, "legal_approved");
    expect(await w.run("withdrawProperty", { propertyId: q2, actor: O.onb1, actingFor: s.repId, reason: "sponsor sold the property privately" })).toBe("withdrawn");
    const q3 = await propertyIn(w, s, "submitted");
    expect(await w.run("withdrawProperty", { propertyId: q3, actor: O.onb1, actingFor: s.repId, reason: "sponsor wants to change the structure" })).toBe("withdrawn");
    const q4 = await propertyIn(w, s, "under_review");
    expect(await w.run("withdrawProperty", { propertyId: q4, actor: O.onb1, actingFor: s.repId, reason: "sponsor found a buyer outside" })).toBe("withdrawn");
  }, 120_000);
});

// ------------------------------------------------------------------ duplicates
describe("duplicate detection (OB-11, OB-14..OB-17)", () => {
  let a: Sponsor;
  let b: Sponsor;
  beforeAll(async () => {
    a = await approvedSponsor(w);
    b = await approvedSponsor(w);
  }, 60_000);

  it("the database and the service normalise identifiers the same way (random Urdu, Arabic, full-width, spacing)", async () => {
    const alphabet = fc.constantFrom(..."aAzZ09 -/._#،۔۰۱۲۳۴۵۶۷۸۹٠١٢٣٤٥٦٧٨٩يىكهیکہابپتٹجچخدڈرڑزسشصطعغفقگلمنوھءآأًـＡＢ１２– \t".split(""));
    const inputs = fc.sample(fc.array(alphabet, { maxLength: 24 }).map((x) => x.join("")), { numRuns: 300, seed: 0x5eed });
    const { rows } = await w.client.query<{ i: string; n: string }>("SELECT i, property.norm(i) AS n FROM unnest($1::text[]) i", [inputs]);
    for (const r of rows) expect(r.n, JSON.stringify(r.i)).toBe(normIdentifier(r.i));
  });

  it("normalisation cases: Urdu digits, case, spacing, punctuation, leading zeros; separators between digits kept", () => {
    expect(normIdentifier(" plot # ۱۲-a ")).toBe("PLOT12A");
    expect(normIdentifier("PLOT12A")).toBe("PLOT12A");
    expect(normIdentifier("Khasra 123 / 4")).toBe("KHASRA123/4");
    expect(normIdentifier("khasra 123-4")).toBe("KHASRA123/4");
    expect(normIdentifier("khasra 1234")).toBe("KHASRA1234");
    expect(normIdentifier("٠٠٧")).toBe("7");
    expect(normIdentifier("ＤＨＡ　Phase-6")).toBe("DHAPHASE6");
    expect(normIdentifier("موضع  کوٹ  لکھپت")).toBe(normIdentifier("موضعکوٹلکھپت"));
    expect(normIdentifier("علي")).toBe(normIdentifier("علی"));
    const k = propertyKey({ province: "punjab", district: "Lahore", society: "DHA Phase 6", plot_no: "12-A" });
    expect(k).toBe("punjab|LAHORE|S:DHAPHASE6|P:12A|::");
    expect(propertyKey({ province: "punjab", district: "lahore ", society: "dha phase-6", plot_no: "12 a" })).toBe(k);
    expect(propertyKey({ province: "punjab", district: "Lahore", mauza: "Kot", khasra: "" })).toBeNull();
  });

  it("an exact match (same key, written differently, by another sponsor) blocks submission and records a case", async () => {
    const n = next();
    const first = await draftProperty(w, a, { society: `Garden Town ${String(n)}`, plot_no: `${String(n)}-B`, district: "Lahore" });
    expect(await submit(w, a, first)).toMatchObject({ submitted: true, outcome: "clear" });
    const urduDigits = String(n).replace(/[0-9]/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[Number(d)] ?? d);
    const copy = await draftProperty(w, b, { society: ` garden  town ${String(n)} `, plot_no: `${urduDigits} b`, district: "LAHORE" });
    const r = await submit(w, b, copy);
    expect(r).toMatchObject({ submitted: false, outcome: "blocked", fraud: false });
    expect(await stateOf(w, copy)).toBe("draft");
    const { rows } = await w.client.query<{ kind: string; reasons: string[] }>("SELECT kind, reasons FROM property.duplicate_candidates WHERE check_id = $1", [r.checkId]);
    expect(rows).toEqual([expect.objectContaining({ kind: "exact", reasons: expect.arrayContaining(["same_property_key"]) as unknown })]);
    expect((await workQueue(w.pool)).some((q) => q.kind === "blocked_submission" && q.entityId === copy)).toBe(true);
  });

  it("the same registered deed (office, number, year) or an identical title document is an exact match, in any state", async () => {
    const first = await propertyIn(w, a, "withdrawn");
    const { rows } = await w.client.query<{ sub_registrar: string; deed_no: string }>("SELECT sub_registrar, deed_no FROM property.properties WHERE id = $1", [first]);
    // Withdrawn from draft: never submitted, so it does not count.
    const sameDeed = await draftProperty(w, b, { sub_registrar: `  ${rows[0]?.sub_registrar.toUpperCase() ?? ""}`, deed_no: rows[0]?.deed_no ?? "" });
    expect((await submit(w, b, sameDeed)).outcome).not.toBe("blocked");
    const rejected = await propertyIn(w, a, "rejected");
    const r2 = await w.client.query<{ sub_registrar: string; deed_no: string }>("SELECT sub_registrar, deed_no FROM property.properties WHERE id = $1", [rejected]);
    const deedCopy = await draftProperty(w, b, { sub_registrar: r2.rows[0]?.sub_registrar.toLowerCase() ?? "", deed_no: ` ${r2.rows[0]?.deed_no ?? ""} ` });
    expect(await submit(w, b, deedCopy)).toMatchObject({ submitted: false, outcome: "blocked" });
    const otherYear = await draftProperty(w, b, { sub_registrar: r2.rows[0]?.sub_registrar ?? "", deed_no: r2.rows[0]?.deed_no ?? "", deed_date: "2016-03-01" });
    const ry = await submit(w, b, otherYear);
    expect(ry).toMatchObject({ submitted: true, outcome: "possible" });
    const titleSha = hex();
    const t1 = await draftProperty(w, a, {}, { docs: new Map([["title_deed", titleSha]]) });
    await submit(w, a, t1);
    const t2 = await draftProperty(w, b, {}, { docs: new Map([["title_deed", titleSha]]) });
    const rt = await submit(w, b, t2);
    expect(rt.outcome).toBe("blocked");
    const c = await w.client.query<{ reasons: string[] }>("SELECT reasons FROM property.duplicate_candidates WHERE check_id = $1", [rt.checkId]);
    expect(c.rows[0]?.reasons).toContain("same_title_document");
  });

  it("possible matches (GPS within 30 m, same parcel other unit) need an onboarding and a compliance officer; two confirmations reject (P3)", async () => {
    const n = next();
    const base = { society: `Model Town ${String(n)}`, plot_no: String(n), building: "Tower A", unit_no: "1" };
    const first = await draftProperty(w, a, { ...base, gps_lat: "31.500000", gps_lon: "74.300000" });
    await submit(w, a, first);
    const near = await draftProperty(w, b, { gps_lat: "31.500200", gps_lon: "74.300000" }); // about 22 m north
    const r = await submit(w, b, near);
    expect(r).toMatchObject({ submitted: true, outcome: "possible" });
    await refused(startReview(w, near), "GUARD", /possible duplicate/);
    const { rows } = await w.client.query<{ id: string; reasons: string[] }>("SELECT id::text, reasons FROM property.duplicate_candidates WHERE check_id = $1", [r.checkId]);
    expect(rows[0]?.reasons).toEqual(["gps_within_radius"]);
    const cand = rows[0]?.id ?? "0";
    await refused(w.run("decideDuplicate", { candidateId: cand, officer: O.onb1, capacity: "onboarding", decision: "clear", reason: "submitter clearing own file" }), "FORBIDDEN", /OB-SOD-1/);
    await refused(w.run("decideDuplicate", { candidateId: cand, officer: O.onb2, capacity: "compliance", decision: "clear", reason: "wrong capacity for this officer" }), "FORBIDDEN");
    expect(await w.run("decideDuplicate", { candidateId: cand, officer: O.onb2, capacity: "onboarding", decision: "clear", reason: "different building across the road" })).toBe("open");
    await refused(w.run("decideDuplicate", { candidateId: cand, officer: O.onb2, capacity: "onboarding", decision: "confirm", reason: "changing my mind now" }), "FORBIDDEN");
    expect(await w.run("decideDuplicate", { candidateId: cand, officer: O.comp1, capacity: "compliance", decision: "clear", reason: "site photos show two buildings" })).toBe("cleared");
    expect(await startReview(w, near)).toBe("under_review");
    // Same parcel, another unit: possible; two confirmations reject the file (P3).
    const unit2 = await draftProperty(w, b, { ...base, unit_no: "2" });
    const r2 = await submit(w, b, unit2);
    const c2 = await w.client.query<{ id: string; reasons: string[] }>("SELECT id::text, reasons FROM property.duplicate_candidates WHERE check_id = $1", [r2.checkId]);
    expect(c2.rows[0]?.reasons).toContain("same_parcel_other_unit");
    await w.run("decideDuplicate", { candidateId: c2.rows[0]?.id ?? "0", officer: O.comp2, capacity: "compliance", decision: "confirm", reason: "same unit, renumbered by the society" });
    expect(await w.run("decideDuplicate", { candidateId: c2.rows[0]?.id ?? "0", officer: O.onb3, capacity: "onboarding", decision: "confirm", reason: "the society letter confirms it" })).toBe("confirmed");
    expect(await stateOf(w, unit2)).toBe("rejected");
  });

  it("OB-17: an exact match on a Tokenization Ready property is a fraud indicator", async () => {
    const tr = await propertyIn(w, a, "tokenization_ready");
    const { rows } = await w.client.query<Record<string, string | null>>("SELECT society, plot_no, district FROM property.properties WHERE id = $1", [tr]);
    const copy = await draftProperty(w, b, { society: rows[0]?.society ?? null, plot_no: rows[0]?.plot_no ?? null, district: rows[0]?.district ?? null });
    expect(await submit(w, b, copy)).toMatchObject({ submitted: false, outcome: "blocked", fraud: true });
    expect((await findDuplicates(w.pool, copy))[0]).toMatchObject({ candidate: tr, kind: "exact", fraud: true });
  }, 60_000);

  it("two sponsors submitting the same property at the same time: one is submitted, the other blocked", async () => {
    const n = next();
    const ids = { society: `Race Society ${String(n)}`, plot_no: String(n) };
    const pa = await draftProperty(w, a, ids);
    const pb = await draftProperty(w, b, ids);
    const results = await Promise.all([submit(w, a, pa), submit(w, b, pb)]);
    expect(results.map((r) => r.outcome).sort()).toEqual(["blocked", "clear"]);
  });

  it("a duplicate check is fast enough to run inside the submission (no hard timing gate: prints the median)", async () => {
    const p = await draftProperty(w, a);
    const times: number[] = [];
    for (let i = 0; i < 5; i++) {
      const t = performance.now();
      await findDuplicates(w.pool, p);
      times.push(performance.now() - t);
    }
    times.sort((x, y) => x - y);
    // eslint-disable-next-line no-console -- reported, not gated (MEMORY: no hard timing gates)
    console.log(`find_duplicates median ${(times[2] ?? 0).toFixed(1)} ms`);
  });
});

// ------------------------------------------------------------------ personal data, audit, append-only, roles
describe("protection of records (PR-1, PR-8, PR-9)", () => {
  it("no CNIC, name, CUIN, NTN or address is stored in readable form anywhere in the property schema", async () => {
    const s = await approvedSponsor(w);
    await propertyIn(w, s, "submitted");
    const ntn = await w.client.query<{ ntn_last4: string }>("SELECT ntn_last4 FROM property.sponsors WHERE id = $1", [s.sponsorId]);
    const needles = [
      s.rep.cnic,
      s.bo.cnic,
      s.rep.cnic.slice(0, 9),
      s.rep.name,
      s.bo.name.toUpperCase(),
      s.legalName,
      s.legalName.toUpperCase(),
      "ZETA HOLDINGS",
      s.address,
      "TESTING AVENUE",
      s.cuin,
      Buffer.from("ZETA").toString("hex"),
    ];
    expect(ntn.rows[0]?.ntn_last4).toMatch(/^[0-9]{4}$/);
    const { rows: tables } = await w.client.query<{ t: string }>("SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'property'");
    expect(tables.length).toBeGreaterThan(30);
    for (const { t } of tables) {
      const { rows } = await w.client.query<{ j: string }>(`SELECT row_to_json(x)::text AS j FROM property.${t} x`);
      for (const r of rows) for (const n of needles) expect(r.j.toUpperCase(), `${t} contains ${n}`).not.toContain(n.toUpperCase());
    }
  });

  it("every transition writes exactly one audit entry; the chain verifies after the whole workflow", async () => {
    const { rows } = await w.client.query<{ events: string; audited: string }>(`
      SELECT (SELECT count(*) FROM property.property_events) + (SELECT count(*) FROM property.sponsor_events) AS events,
             (SELECT count(*) FROM property.audit a WHERE a.detail->>'ref' LIKE 'property_events:%' OR a.detail->>'ref' LIKE 'sponsor_events:%') AS audited`);
    expect(rows[0]?.events).toBe(rows[0]?.audited);
    const dup = await w.client.query("SELECT detail->>'ref' FROM property.audit WHERE detail ? 'ref' GROUP BY 1 HAVING count(*) > 1");
    expect(dup.rows).toEqual([]);
    expect(await verifyAudit(w.pool)).toEqual([]);
  });

  it("append-only: history cannot be updated, deleted or truncated through any role", async () => {
    for (const t of ["audit", "property_events", "sponsor_events", "documents", "reviews", "review_documents", "valuations", "ic_votes", "duplicate_candidates"]) {
      expect(await sqlRefused(`DELETE FROM property.${t} WHERE true`), t).toBe("42501");
      expect(await sqlRefused(`TRUNCATE property.${t} CASCADE`), t).toBe("42501");
    }
    expect(await sqlRefused("UPDATE property.reviews SET decision = 'pass' WHERE decision = 'fail'")).toBe("42501");
    expect(await sqlRefused("UPDATE property.requests SET status = 'approved' WHERE status = 'rejected'")).toBe("23514");
    expect(await sqlRefused("DELETE FROM property.sponsors WHERE true")).toBe("42501");
  });

  it("roles: the reader sees overviews only; the writer cannot decide; the reviewer cannot read sealed sponsor rows", async () => {
    const c = w.client;
    const as = async (role: string, sql: string): Promise<string | null> => {
      await c.query("BEGIN");
      try {
        await c.query(`SET LOCAL ROLE ${role}`);
        await c.query(sql);
        return null;
      } catch (e) {
        return (e as { code: string }).code;
      } finally {
        await c.query("ROLLBACK");
      }
    };
    expect(await as("pt_property_reader", "SELECT count(*) FROM property.property_overview")).toBeNull();
    expect(await as("pt_property_reader", "SELECT count(*) FROM property.reviews")).toBe("42501");
    expect(await as("pt_property_reader", "SELECT count(*) FROM property.fmu_assessments")).toBe("42501");
    expect(await as("pt_property_reader", "SELECT count(*) FROM property.verify_audit()")).toBeNull();
    expect(await as("pt_property_writer", "SELECT property.decide_request(1, 'x-1', true, 'trying to approve')")).toBe("42501");
    expect(await as("pt_property_writer", "SELECT count(*) FROM property.requests")).toBe("42501");
    expect(await as("pt_property_writer", "INSERT INTO property.audit (at, actor, action, detail, prev_hash, hash) VALUES (now(), 'x', 'xxx', '{}', '\\x00', '\\x00')")).toBe("42501");
    expect(await as("pt_property_reviewer", "SELECT count(*) FROM property.reviews")).toBeNull();
    expect(await as("pt_property_reviewer", "SELECT count(*) FROM property.sponsors")).toBe("42501");
    expect(await as("pt_property_reviewer", "SELECT property.request_duty('a-1', 'trustee', 'b-1', 'self service duty')")).toBe("42501");
    expect(await as("pt_property_admin", "SELECT property.submit_property(gen_random_uuid(), 'a-1', 1)")).toBe("42501");
  });
});

// Runs last: tampering breaks the chain for everything after it.
describe("audit tamper detection (PR-8)", () => {
  it("finds an edited, a deleted and an inserted entry, a changed document hash and a state moved around the log", async () => {
    const c = w.client;
    expect(await verifyAudit(w.pool)).toEqual([]);
    await c.query("ALTER TABLE property.documents DISABLE TRIGGER USER");
    await c.query("UPDATE property.documents SET sha256 = decode(repeat('ab', 32), 'hex') WHERE id = (SELECT id FROM property.documents ORDER BY uploaded_at LIMIT 1)");
    await c.query("ALTER TABLE property.documents ENABLE TRIGGER USER");
    expect((await verifyAudit(w.pool)).map((p) => p.problem)).toEqual([expect.stringMatching(/^document .* changed after it was recorded$/)]);
    await c.query("ALTER TABLE property.properties DISABLE TRIGGER USER");
    await c.query("UPDATE property.properties SET state = 'tokenization_ready' WHERE id = (SELECT id FROM property.properties WHERE state = 'draft' LIMIT 1)");
    await c.query("ALTER TABLE property.properties ENABLE TRIGGER USER");
    expect((await verifyAudit(w.pool)).some((p) => /state does not match its event log/.test(p.problem))).toBe(true);
    await c.query("ALTER TABLE property.audit DISABLE TRIGGER USER");
    await c.query("UPDATE property.audit SET detail = detail || '{\"reason\": \"edited later\"}' WHERE id = 10");
    await c.query("DELETE FROM property.audit WHERE id = 20");
    await c.query("ALTER TABLE property.audit ENABLE TRIGGER USER");
    const problems = await verifyAudit(w.pool);
    expect(problems).toEqual(expect.arrayContaining([{ auditId: "10", problem: "content does not match its hash" }, { auditId: "21", problem: "prev_hash does not match" }]));
    await c.query("INSERT INTO property.risk_ratings (sponsor_id, rating, reasons, rated_by) SELECT id, 'low', 'written around the API', 'x-admin' FROM property.sponsors LIMIT 1");
    expect((await verifyAudit(w.pool)).some((p) => /^risk_ratings \d+ has no audit entry$/.test(p.problem))).toBe(true);
  });

  it("every transition of S-01 was exercised by this file", async () => {
    const { rows } = await w.client.query<{ t: string }>(`
      SELECT t.entity || ':' || t.code || ':' || t.from_state AS t FROM property.transitions t
      WHERE NOT EXISTS (SELECT 1 FROM property.sponsor_events e WHERE t.entity = 'sponsor' AND e.code = t.code AND e.from_state = t.from_state)
        AND NOT EXISTS (SELECT 1 FROM property.property_events e WHERE t.entity = 'property' AND e.code = t.code AND e.from_state = t.from_state)`);
    expect(rows.map((r) => r.t)).toEqual([]);
  });
});
