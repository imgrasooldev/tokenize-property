import fc from "fast-check";
import { afterAll, beforeAll, expect, it } from "vitest";
import { PropertyError, verifyAudit } from "../src/service.ts";
import {
  addDoc,
  approvedSponsor,
  committeeApproves,
  completeDueDiligence,
  currentDoc,
  draftProperty,
  hex,
  makeWorld,
  O,
  stateOf,
  trusteeAccepts,
  type Sponsor,
  type World,
} from "./world.ts";

/**
 * Random sequences of S-01 property operations, each by the right officer or a wrong one, against a
 * reference model of the state machine (S-01 §3.2). After every step the database's state must equal
 * the model's, and an operation must succeed exactly when the model says it may. Legal Approved is
 * reachable only with five fresh passing reviews and a committee quorum; Tokenization Ready only with
 * the trustee's acceptance.
 */

let w: World;
let s: Sponsor;

beforeAll(async () => {
  w = await makeWorld();
  s = await approvedSponsor(w);
}, 120_000);

afterAll(async () => {
  await w.drop();
}, 120_000);

type Op = "advance" | "submit" | "return" | "start" | "query" | "withdraw" | "hold" | "resume" | "rejectHold" | "reopen" | "dd" | "approve" | "trustee" | "rejectReview" | "supersede";
interface Step {
  op: Op;
  good: boolean;
}
interface Model {
  state: string;
  /** All five reviews recorded, fresh and passing. */
  dd: boolean;
}

const REVIEWED = ["under_review", "legal_approved", "tokenization_ready", "on_hold"];

/** What the model expects: the next state if the operation is allowed, or null if it must be refused. */
function expected(m: Model, step: Step): Model | null {
  const { state } = m;
  if (!step.good && step.op !== "dd" && step.op !== "supersede") return null;
  switch (step.op) {
    case "advance":
      return null;
    case "submit":
      return state === "draft" ? { ...m, state: "submitted" } : null;
    case "return":
      return state === "submitted" ? { ...m, state: "draft" } : null;
    case "start":
      return state === "submitted" ? { ...m, state: "under_review" } : null;
    case "query":
      return state === "under_review" ? { ...m, state: "draft" } : null;
    case "withdraw":
      return ["draft", "submitted", "under_review", "legal_approved"].includes(state) ? { ...m, state: "withdrawn" } : null;
    case "hold":
      return ["under_review", "legal_approved", "tokenization_ready"].includes(state) ? { ...m, state: "on_hold" } : null;
    case "resume":
      return state === "on_hold" ? { ...m, state: "under_review" } : null;
    case "rejectHold":
      return state === "on_hold" ? { ...m, state: "rejected" } : null;
    case "reopen":
      return REVIEWED.includes(state) ? { dd: false, state: ["legal_approved", "tokenization_ready"].includes(state) ? "under_review" : state } : null;
    case "dd":
      return state === "under_review" ? { ...m, dd: true } : null;
    case "approve":
      return state === "under_review" && m.dd ? { ...m, state: "legal_approved" } : null;
    case "trustee":
      return state === "legal_approved" && m.dd ? { ...m, state: "tokenization_ready" } : null;
    case "rejectReview":
      return state === "under_review" ? { ...m, state: "rejected" } : null;
    case "supersede":
      return ["rejected", "withdrawn"].includes(state) ? null : { dd: false, state: ["legal_approved", "tokenization_ready"].includes(state) ? "under_review" : state };
  }
}

async function decideAndClean(requestId: bigint, checker: string, good: boolean, cleaner: string): Promise<void> {
  if (good) {
    await w.run("decideRequest", { requestId, officer: checker, approve: true, reason: "checked the evidence, agree" });
    return;
  }
  try {
    await w.run("decideRequest", { requestId, officer: checker, approve: true, reason: "approving my own request" });
  } finally {
    await w.run("decideRequest", { requestId, officer: cleaner, approve: false, reason: "refused: the maker cannot check" });
  }
}

async function perform(p: string, step: Step): Promise<void> {
  const g = step.good;
  switch (step.op) {
    case "advance":
      return;
    case "submit":
      await w.run("submitProperty", { propertyId: p, actor: g ? O.onb1 : O.legal1, actingFor: s.repId });
      return;
    case "return":
      await w.run("returnProperty", { propertyId: p, officer: g ? O.onb2 : O.onb1, reason: "a document is out of date" });
      return;
    case "start":
      await w.run("startReview", { propertyId: p, officer: O.onb2, legal: O.legal1, valuation: g ? O.val1 : O.legal1, technical: O.tech1 });
      return;
    case "query":
      await w.run("queryProperty", { propertyId: p, reviewer: g ? O.legal1 : O.legal2, query: "please send the latest fard" });
      return;
    case "withdraw":
      await w.run("withdrawProperty", { propertyId: p, actor: g ? O.onb1 : O.ic1, actingFor: s.repId, reason: "sponsor withdrew the file" });
      return;
    case "hold":
      await w.run("holdProperty", { propertyId: p, actor: g ? O.legal1 : O.tech1, reason: "stay order on the parcel" });
      return;
    case "resume":
    case "rejectHold": {
      const code = step.op === "resume" ? "P13" : "P14";
      const r = await w.run("requestTransition", {
        entity: "property",
        id: p,
        code,
        officer: O.legal1,
        reason: "court record checked by counsel",
        detail: code === "P13" ? { evidence: hex() } : { curable: false },
      });
      await decideAndClean(r, g ? O.legalHead : O.legal1, g, O.legalHead);
      return;
    }
    case "reopen":
      await w.run("reopen", { propertyId: p, actor: g ? O.tech1 : O.ic1, disciplines: ["technical"], reason: "material change reported" });
      return;
    case "dd":
      await completeDueDiligence(w, s, p);
      return;
    case "approve":
      if (g) await committeeApproves(w, p);
      else await w.run("openIc", { propertyId: p, chair: O.legal1 });
      return;
    case "trustee":
      await trusteeAccepts(w, s, p, g ? O.trustee : O.legalHead);
      return;
    case "rejectReview": {
      const report = await addDoc(w, { sponsorId: s.sponsorId, propertyId: p, docType: "technical_report", actor: O.tech1 });
      await w.run("recordReview", {
        propertyId: p,
        reviewer: O.tech1,
        discipline: "technical",
        scope: "structure and approvals",
        method: "site visit",
        findings: "unapproved floors",
        decision: "fail",
        documents: [report],
      });
      const r = await w.run("requestTransition", { entity: "property", id: p, code: "P6", officer: O.tech1, reason: "unapproved construction", detail: { discipline: "technical", curable: true } });
      await decideAndClean(r, g ? O.tech2 : O.tech1, g, O.tech2);
      return;
    }
    case "supersede": {
      const old = await currentDoc(w, p, "title_deed");
      await addDoc(w, { sponsorId: s.sponsorId, propertyId: p, docType: "title_deed", actor: O.legal1, ...(old ? { supersedes: old } : {}) });
      return;
    }
  }
}

/** "advance" is the next forward step for the model's state, so runs reach the deep states often. */
function resolve(m: Model, op: Op): Op {
  if (op !== "advance") return op;
  const forward = new Map<string, Op>([
    ["draft", "submit"],
    ["submitted", "start"],
    ["under_review", m.dd ? "approve" : "dd"],
    ["legal_approved", "trustee"],
    ["tokenization_ready", "reopen"],
    ["on_hold", "resume"],
  ]);
  return forward.get(m.state) ?? "submit";
}

const stepArb: fc.Arbitrary<Step> = fc.record({
  op: fc.oneof(
    { arbitrary: fc.constant<Op>("advance"), weight: 8 },
    { arbitrary: fc.constantFrom<Op>("submit", "start", "dd", "approve", "trustee"), weight: 2 },
    { arbitrary: fc.constantFrom<Op>("return", "query", "hold", "resume", "reopen", "supersede"), weight: 3 },
    { arbitrary: fc.constantFrom<Op>("withdraw", "rejectHold", "rejectReview"), weight: 1 },
  ),
  good: fc.oneof({ arbitrary: fc.constant(true), weight: 4 }, { arbitrary: fc.constant(false), weight: 1 }),
});

it("random operation sequences follow the reference model; approvals are never skipped", async () => {
  let runs = 0;
  let maxState = 0;
  let accepted = 0;
  let refusedCount = 0;
  const order = ["draft", "submitted", "under_review", "legal_approved", "tokenization_ready"];
  await fc.assert(
    fc.asyncProperty(fc.array(stepArb, { minLength: 4, maxLength: 12 }), async (steps) => {
      runs++;
      const p = await draftProperty(w, s);
      let m: Model = { state: "draft", dd: false };
      for (const raw of steps) {
        const step = { ...raw, op: resolve(m, raw.op) };
        const want = expected(m, step);
        if (want) accepted++;
        else refusedCount++;
        let error: unknown = null;
        try {
          await perform(p, step);
        } catch (e) {
          error = e;
        }
        if (want) {
          expect(error, `${step.op}/${String(step.good)} from ${m.state} should succeed`).toBeNull();
          m = want;
        } else {
          expect(error, `${step.op}/${String(step.good)} from ${m.state} must be refused`).toBeInstanceOf(PropertyError);
          // A refused step never moves the state. A refused rejection under review still left its
          // failed technical review behind, so the file needs new reviews before the committee.
          if (step.op === "rejectReview" && m.state === "under_review") m = { ...m, dd: false };
        }
        expect(await stateOf(w, p), `after ${step.op}/${String(step.good)}`).toBe(m.state);
        maxState = Math.max(maxState, order.indexOf(m.state));
      }
    }),
    { numRuns: 30, endOnFailure: true, seed: 0x5eed },
  );
  expect(runs).toBe(30);
  // With the fixed seed the runs reach Tokenization Ready and mix accepted and refused steps.
  expect(order.at(maxState)).toBe("tokenization_ready");
  expect(accepted).toBeGreaterThan(20);
  expect(refusedCount).toBeGreaterThan(10);
  // Invariants over everything the runs did.
  const { rows } = await w.client.query<{ bad: string }>(`
    SELECT 'P8 by a non-trustee: ' || e.actor AS bad FROM property.property_events e
      WHERE e.code = 'P8' AND NOT property.has_duty(e.actor, ARRAY['trustee'])
    UNION ALL
    SELECT 'P7 without a quorate approved meeting ' || e.property_id FROM property.property_events e
      WHERE e.code = 'P7' AND NOT EXISTS (SELECT 1 FROM property.ic_meetings m WHERE m.property_id = e.property_id AND m.status = 'approved' AND 'ic:' || m.id = e.checker)
    UNION ALL
    SELECT 'tokenization_ready without a legal approval first ' || e.property_id FROM property.property_events e
      WHERE e.to_state = 'tokenization_ready' AND NOT EXISTS (SELECT 1 FROM property.property_events x WHERE x.property_id = e.property_id AND x.code = 'P7' AND x.id < e.id)`);
  expect(rows).toEqual([]);
  expect(await verifyAudit(w.pool)).toEqual([]);
  // eslint-disable-next-line no-console -- coverage of the random runs, for the log
  console.log(`model test: ${String(runs)} runs, ${String(accepted)} accepted and ${String(refusedCount)} refused steps, deepest state ${order.at(maxState) ?? "?"}`);
}, 900_000);
