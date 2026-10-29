import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mockProviders, KycService, Peppers } from "@pt/kyc";
import pg from "pg";
import { migrate } from "../../db/src/migrate.ts";
import { scratchDatabase } from "../../db/test/helpers.ts";
import { committeeClose, committeeVote, officerForDuty, propertyRequest, trusteePropertyDecision, type PortalResult } from "../../db/test/officers.ts";
import { SponsorSecrets } from "../src/crypto.ts";
import { mapError, PropertyService, runAction, type ActionInput, type ActionName, type ActionResult, type Identifiers } from "../src/service.ts";
import { contiguousMigrations } from "./helpers.ts";

/** A scratch database with every migration, KYC mocks and the S-01 officers, for the property tests. */

export const O = {
  adm1: "adm-1",
  adm2: "adm-2",
  onb1: "onb-1",
  onb2: "onb-2",
  onb3: "onb-3",
  comp1: "comp-1",
  comp2: "comp-2",
  senior: "comp-senior",
  legal1: "legal-1",
  legal2: "legal-2",
  legalHead: "legal-head",
  val1: "val-1",
  val2: "val-2",
  tech1: "tech-1",
  tech2: "tech-2",
  ic1: "ic-1",
  ic2: "ic-2",
  ic3: "ic-indep",
  ic4: "ic-4",
  trustee: "trustee-1",
} as const;

const DUTIES: [string, string][] = [
  [O.onb1, "onboarding"],
  [O.onb2, "onboarding"],
  [O.onb3, "onboarding"],
  [O.comp1, "compliance"],
  [O.comp2, "compliance"],
  [O.senior, "compliance_senior"],
  [O.legal1, "legal"],
  [O.legal2, "legal"],
  [O.legalHead, "legal_head"],
  [O.val1, "valuation"],
  [O.val2, "valuation"],
  [O.tech1, "technical"],
  [O.tech2, "technical"],
  [O.ic1, "ic_member"],
  [O.ic2, "ic_member"],
  [O.ic3, "ic_independent"],
  [O.ic4, "ic_member"],
  [O.trustee, "trustee"],
];

export interface World {
  client: pg.Client;
  pool: pg.Pool;
  settings: pg.ClientConfig;
  svc: PropertyService;
  kyc: KycService;
  secrets: SponsorSecrets;
  valuers: [string, string, string];
  drop: () => Promise<void>;
  run: <K extends ActionName>(name: K, input: ActionInput<K>) => Promise<ActionResult<K>>;
}

let seq = Math.floor(Math.random() * 1_000_000);
export const next = (): number => ++seq;
export const hex = (): string => randomBytes(32).toString("hex");
export const hashOf = (s: string): string => createHash("sha256").update(s).digest("hex");
const letters = (n: number): string =>
  String(n)
    .split("")
    .map((d) => "ABCDEFGHIJ".charAt(Number(d)))
    .join("");

export async function makeWorld(): Promise<World> {
  const s = await scratchDatabase();
  await migrate(s.client, contiguousMigrations());
  const pool = new pg.Pool({ ...s.settings, max: 6 });
  const secrets = new SponsorSecrets(Peppers.of([{ version: 1, key: randomBytes(32) }]), randomBytes(32));
  const kyc = new KycService(pool, mockProviders(), Peppers.of([{ version: 1, key: randomBytes(32) }]), randomBytes(32));
  const w: World = {
    client: s.client,
    pool,
    settings: s.settings,
    svc: new PropertyService(pool, secrets),
    kyc,
    secrets,
    valuers: ["", "", ""],
    drop: async () => {
      await pool.end();
      await s.drop();
    },
    run: (name, input) => (name === "requestTransition" ? portalRequest(s.client, input as ActionInput<"requestTransition">) : runAction(pool, name, input)) as Promise<ActionResult<typeof name>>,
  };
  for (const [actor, duty] of DUTIES) await grant(w, actor, duty);
  const valuers: string[] = [];
  for (let i = 0; i < 3; i++) {
    const id = await w.run("addValuer", { licence: `PBA/${String(next())}`, panel: "pba", actor: O.adm1 });
    await w.run("approveValuer", { valuerId: id, actor: O.adm2 });
    valuers.push(id.toString());
  }
  w.valuers = [valuers[0] ?? "", valuers[1] ?? "", valuers[2] ?? ""];
  return w;
}

export async function grant(w: World, actor: string, duty: string): Promise<void> {
  // Migration 0016 (A-7): a duty needs an officer of the admin portal with a matching role.
  await officerForDuty(w.client, actor, duty);
  const id = await w.run("requestDuty", { actor, duty: duty as "onboarding", by: O.adm1, reason: "assigned by the operations head" });
  await w.run("decideDuty", { dutyId: id, by: O.adm2, approve: true, reason: "checked against the HR record" });
}

/** A KYC subject; `last` 1 = verified, 9 = NADRA unavailable (pending). */
export async function subject(w: World, last = 1): Promise<{ id: string; cnic: string; name: string }> {
  const n = next();
  const cnic = `${String(352020000000 + n)}${String(last)}`;
  const name = `Testperson ${letters(n)}`;
  const r = await w.kyc.onboard({ cnic, fullName: name, livenessSessionId: `sess-good-${String(n).padStart(6, "0")}` });
  return { id: r.subjectId, cnic, name };
}

export const KYB_DOCS = ["certificate_of_incorporation", "memorandum_articles", "annual_return", "directors_list", "ntn_certificate", "board_resolution"];
export const PROPERTY_DOCS = [
  "title_deed",
  "land_record_extract",
  "property_tax_receipt",
  "authority_to_sell",
  "approved_building_plan",
  "completion_certificate",
  "utility_bill",
  "insurance_policy",
];

export async function addDoc(
  w: World,
  o: { sponsorId: string; propertyId?: string; docType: string; actor: string; actingFor?: string; sha?: string; supersedes?: string },
): Promise<string> {
  return w.run("addDocument", {
    sponsorId: o.sponsorId,
    propertyId: o.propertyId ?? null,
    docType: o.docType,
    sha256: o.sha ?? hex(),
    sizeBytes: 123_456,
    mediaType: "application/pdf",
    storeRef: `vault://docs/${randomUUID()}`,
    actor: o.actor,
    actingFor: o.actingFor ?? null,
    supersedes: o.supersedes ?? null,
  });
}

export interface Sponsor {
  sponsorId: string;
  repId: string;
  rep: { id: string; cnic: string; name: string };
  bo: { id: string; cnic: string; name: string };
  cuin: string;
  legalName: string;
  address: string;
}

/** A company sponsor in KYB draft, with its people and documents. */
export async function draftSponsor(w: World): Promise<Sponsor> {
  const n = next();
  const cuin = `00${String(1_000_000 + n).slice(-7)}`;
  const legalName = `Zeta Holdings ${letters(n)} (Private) Limited`;
  const address = `Office ${letters(n)}, Testing Avenue, Gulberg III, Lahore`;
  const sponsorId = await w.svc.createSponsor({ kind: "company", legalName, address, cuin, ntn: `${String(7_000_000 + n)}-1`, actor: O.onb1 });
  const rep = await subject(w);
  const bo = await subject(w);
  const repId = (await w.run("addPerson", { sponsorId, subjectId: rep.id, role: "representative", powers: ["submit", "upload", "respond", "withdraw"], actor: O.onb1 })).toString();
  await w.run("addPerson", { sponsorId, subjectId: rep.id, role: "director", actor: O.onb1 });
  await w.run("addPerson", { sponsorId, subjectId: bo.id, role: "beneficial_owner", ownershipBp: 6000, control: "shares", chainDepth: 1, actor: O.onb1 });
  for (const t of KYB_DOCS) await addDoc(w, { sponsorId, docType: t, actor: O.onb1, actingFor: repId });
  return { sponsorId, repId, rep, bo, cuin, legalName, address };
}

/** K1, K2, the KYB records and K4 (maker comp-1, checker comp-2). */
export async function approveSponsor(w: World, s: Sponsor): Promise<void> {
  await w.run("submitKyb", { sponsorId: s.sponsorId, actor: O.onb1, actingFor: s.repId });
  await w.run("screenKyb", { sponsorId: s.sponsorId, actor: O.onb2, accept: true });
  await w.run("recordRegistrationCheck", { sponsorId: s.sponsorId, method: "secp_eservices", outcome: "verified", evidence: hex(), actor: O.onb2 });
  await w.run("recordScreening", { sponsorId: s.sponsorId, provider: "mock-screen", listVersion: "un-2026-10", outcome: "clear", evidence: hex(), actor: O.comp1 });
  await w.run("recordRisk", { sponsorId: s.sponsorId, rating: "low", reasons: "listed group, simple ownership", actor: O.comp1 });
  const req = await w.run("requestTransition", { entity: "sponsor", id: s.sponsorId, code: "K4", officer: O.comp1, reason: "all KYB checks complete and clear" });
  await w.run("decideRequest", { requestId: req, officer: O.comp2, approve: true, reason: "reviewed the file, agree" });
}

export async function approvedSponsor(w: World): Promise<Sponsor> {
  const s = await draftSponsor(w);
  await approveSponsor(w, s);
  return s;
}

export function identifiers(n = next(), over: Identifiers = {}): Identifiers {
  return {
    province: "punjab",
    district: "Lahore",
    tehsil: "Lahore Cantt",
    society: `Test Society ${letters(n)}`,
    plot_no: `${String(n)}-A`,
    sub_registrar: "Sub-Registrar Cantt",
    deed_no: `D${String(n)}`,
    deed_volume: "12",
    deed_page: "34",
    deed_date: "2015-03-01",
    authority_file_no: `AF-${String(n)}`,
    excise_no: `EX-${String(n)}`,
    address: `Plot ${String(n)}-A, Test Society ${letters(n)}, Lahore`,
    land_area: "10",
    land_area_unit: "marla",
    covered_area_sqft: "2250",
    gps_lat: (24 + (n % 1300) * 0.01).toFixed(6),
    gps_lon: (61 + Math.floor(n / 1300) * 0.01 + (n % 7) * 0.001).toFixed(6),
    use: "commercial",
    built: true,
    occupancy: "vacant",
    declared_charges: false,
    ...over,
  };
}

/** A draft property of the sponsor with every mandatory document. */
export async function draftProperty(w: World, s: Sponsor, over: Identifiers = {}, opts: { previousId?: string; docs?: Map<string, string> } = {}): Promise<string> {
  const propertyId = await w.run("createProperty", { sponsorId: s.sponsorId, actor: O.onb1, actingFor: s.repId, previousId: opts.previousId ?? null, identifiers: identifiers(next(), over) });
  for (const t of PROPERTY_DOCS) await addDoc(w, { sponsorId: s.sponsorId, propertyId, docType: t, actor: O.onb1, actingFor: s.repId, ...(opts.docs?.has(t) ? { sha: opts.docs.get(t) ?? "" } : {}) });
  return propertyId;
}

export async function submit(w: World, s: Sponsor, propertyId: string): Promise<{ submitted: boolean; checkId: number; outcome: string; possible: number; fraud: boolean }> {
  return w.run("submitProperty", { propertyId, actor: O.onb1, actingFor: s.repId });
}

export async function startReview(w: World, propertyId: string): Promise<string> {
  return w.run("startReview", { propertyId, officer: O.onb2, legal: O.legal1, valuation: O.val1, technical: O.tech1 });
}

/** Current document id of a type (null if none). */
export async function currentDoc(w: World, propertyId: string, docType: string): Promise<string | null> {
  const { rows } = await w.pool.query<{ document_id: string }>(
    "SELECT document_id FROM property.document_list WHERE property_id = $1 AND doc_type = $2 AND current ORDER BY uploaded_at DESC LIMIT 1",
    [propertyId, docType],
  );
  return rows[0]?.document_id ?? null;
}

/**
 * Records everything the five reviews need and five passing reviews by the assigned reviewers
 * (legal-1, val-1, tech-1). Idempotent: documents with the same bytes are recorded once.
 */
export async function completeDueDiligence(w: World, s: Sponsor, propertyId: string, values: [bigint, bigint] = [10_000_000_000n, 10_500_000_000n]): Promise<void> {
  const ensure = async (docType: string, actor: string): Promise<string> =>
    (await currentDoc(w, propertyId, docType)) ?? addDoc(w, { sponsorId: s.sponsorId, propertyId, docType, actor, sha: hashOf(`${propertyId}:${docType}:${hex()}`) });
  const title = await ensure("title_deed", O.legal1);
  const fard = await ensure("land_record_extract", O.legal1);
  for (const d of [title, fard]) {
    await w.run("verifyDocument", { documentId: d, actor: O.legal1, method: "in_person", office: "Sub-Registrar Cantt", verifiedOn: "2026-10-01", outcome: "verified", evidence: hex() });
  }
  await w.run("addTitleLink", { propertyId, actor: O.legal1, position: 1, kind: "allotment", instrumentRef: "ALLOT-1", registeredOn: "1990-01-01", documentId: fard });
  await w.run("addTitleLink", { propertyId, actor: O.legal1, position: 2, kind: "sale_deed", instrumentRef: "D-1", registeredOn: "2015-03-01", documentId: title });
  const search = await ensure("encumbrance_search", O.legal1);
  const opinion = await ensure("legal_opinion", O.legal1);
  const technical = await ensure("technical_report", O.tech1);
  const r1 = await addDoc(w, { sponsorId: s.sponsorId, propertyId, docType: "valuation_report", actor: O.val1 });
  const r2 = await addDoc(w, { sponsorId: s.sponsorId, propertyId, docType: "valuation_report", actor: O.val1 });
  const today = new Date().toISOString().slice(0, 10);
  await w.run("recordValuation", { propertyId, actor: O.val1, valuerId: w.valuers[0], valuePaisa: values[0], valuedOn: today, reportId: r1, independence: hex() });
  await w.run("recordValuation", { propertyId, actor: O.val1, valuerId: w.valuers[1], valuePaisa: values[1], valuedOn: today, reportId: r2, independence: hex() });
  const review = (discipline: "title" | "encumbrance" | "valuation" | "legal_opinion" | "technical", reviewer: string, documents: string[]) =>
    w.run("recordReview", {
      propertyId,
      reviewer,
      discipline,
      scope: `full ${discipline} review`,
      method: "documents and source checks",
      findings: "no issues found in the documents",
      decision: "pass",
      documents,
    });
  await review("title", O.legal1, [title, fard]);
  await review("encumbrance", O.legal1, [search]);
  await review("legal_opinion", O.legal1, [opinion]);
  await review("technical", O.tech1, [technical]);
  const { rows } = await w.pool.query<{ id: string }>(
    "SELECT d.document_id AS id FROM property.document_list d WHERE d.property_id = $1 AND d.doc_type = 'valuation_report' AND d.current",
    [propertyId],
  );
  await review("valuation", O.val1, rows.map((r) => r.id));
}

/**
 * A portal decision (migration 0026) as the property service would report it: the status, or a
 * PropertyError with the code of the backend's refusal (or FORBIDDEN when the portal refuses the
 * session or permission).
 */
/**
 * Migration 0045: an S-01 request under an officer's handle goes through the portal (session,
 * step-up); any other name goes to the database directly (and is refused by the duty rules there).
 */
async function portalRequest(client: pg.Client, i: ActionInput<"requestTransition">): Promise<bigint> {
  const { rowCount } = await client.query("SELECT 1 FROM admin.officers WHERE handle = $1", [i.officer]);
  if (!rowCount) return runAction(client, "requestTransition", i);
  let r: PortalResult;
  try {
    r = await propertyRequest(client, i.officer, { entity: i.entity, id: i.id, code: i.code, reason: i.reason, detail: i.detail ?? {} });
  } catch (e) {
    throw mapError(e);
  }
  if (!r.ok) throw mapError({ code: r.state ?? "42501", message: r.error ?? "refused" });
  return BigInt(r.id ?? 0);
}

export async function viaPortal(p: Promise<PortalResult>): Promise<string> {
  let r: PortalResult;
  try {
    r = await p;
  } catch (e) {
    throw mapError(e);
  }
  if (!r.ok) throw mapError({ code: r.state ?? "42501", message: r.error ?? "refused" });
  return r.status ?? "";
}

/** A committee member's vote in the portal (votes under an officer's handle are portal-only since 0026). */
export function icVote(w: World, member: string, meetingId: string | bigint, vote: "approve" | "reject" | "abstain" | "conflict", reason?: string): Promise<string> {
  return viaPortal(committeeVote(w.client, member, String(meetingId), vote, reason));
}

/** The chair closes the meeting in the portal. */
export function icClose(w: World, chair: string, meetingId: string | bigint): Promise<string> {
  return viaPortal(committeeClose(w.client, chair, String(meetingId), hex()));
}

/** The trustee's P8 decision in the portal. */
export function trusteeDecision(w: World, trustee: string, propertyId: string, accept: boolean, structureId?: string, reason?: string): Promise<string> {
  return viaPortal(
    trusteePropertyDecision(w.client, trustee, propertyId, accept ? "accept" : "decline", { ...(structureId ? { structureId } : {}), ...(reason ? { reason } : {}) }),
  );
}

/** IC with three approving votes (one independent): P7. The chair opens; votes and the close are cast in the portal. */
export async function committeeApproves(w: World, propertyId: string): Promise<string> {
  const m = await w.run("openIc", { propertyId, chair: O.ic1 });
  await icVote(w, O.ic1, m, "approve");
  await icVote(w, O.ic2, m, "approve");
  await icVote(w, O.ic3, m, "approve");
  return icClose(w, O.ic1, m);
}

/** Structure by the legal head and the trustee's acceptance: P8. */
export async function trusteeAccepts(w: World, s: Sponsor, propertyId: string, trustee: string = O.trustee): Promise<string> {
  const deed = (await currentDoc(w, propertyId, "trust_deed")) ?? (await addDoc(w, { sponsorId: s.sponsorId, propertyId, docType: "trust_deed", actor: O.legalHead }));
  const structureId = await w.run("recordStructure", {
    propertyId,
    actor: O.legalHead,
    kind: "spv",
    shariah: false,
    unitRights: { income: "pro rata net rent", exit: "pro rata sale proceeds", voting: "sale needs 75 %", information: "quarterly reports" },
    plannedUnits: 1_000_000n,
    trustDeedId: deed,
  });
  return trusteeDecision(w, trustee, propertyId, true, structureId.toString(), "documents and structure accepted");
}

export async function stateOf(w: World, propertyId: string): Promise<string> {
  const { rows } = await w.pool.query<{ state: string }>("SELECT state FROM property.properties WHERE id = $1", [propertyId]);
  return rows[0]?.state ?? "unknown";
}

/** A property of the sponsor advanced to the given state through the real workflow. */
export async function propertyIn(w: World, s: Sponsor, state: string): Promise<string> {
  const p = await draftProperty(w, s);
  if (state === "draft") return p;
  if (state === "withdrawn") {
    await w.run("withdrawProperty", { propertyId: p, actor: O.onb1, actingFor: s.repId, reason: "sponsor decided not to proceed" });
    return p;
  }
  await submit(w, s, p);
  if (state === "submitted") return p;
  await startReview(w, p);
  if (state === "under_review") return p;
  if (state === "on_hold") {
    await w.run("holdProperty", { propertyId: p, actor: O.legal1, reason: "stay order served on the parcel" });
    return p;
  }
  if (state === "rejected") {
    await w.run("holdProperty", { propertyId: p, actor: O.legal1, reason: "stay order served on the parcel" });
    const r = await w.run("requestTransition", { entity: "property", id: p, code: "P14", officer: O.legal1, reason: "stay order confirmed by the court", detail: { curable: false } });
    await w.run("decideRequest", { requestId: r, officer: O.legalHead, approve: true, reason: "confirmed with the court record" });
    return p;
  }
  await completeDueDiligence(w, s, p);
  await committeeApproves(w, p);
  if (state === "legal_approved") return p;
  await trusteeAccepts(w, s, p);
  return p;
}
