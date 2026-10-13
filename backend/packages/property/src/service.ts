import { randomUUID } from "node:crypto";
import type pg from "pg";
import { z } from "zod";
import { type RegistrationKind, type SponsorSecrets, normalizeRegistration } from "./crypto.ts";
import { PROVINCES } from "./normalize.ts";

/**
 * Sponsor onboarding, property submission and due diligence (spec S-01, migration 0014).
 *
 * The database decides: every state change, guard, duty and maker-checker rule lives in the
 * property.* SQL functions. This module validates input at the boundary (zod), turns registration
 * numbers into keyed hashes and seals names and addresses before they reach the database (PR-1), and
 * maps SQL errors to typed errors. Actor ids come from the authenticated portal session (Step 6);
 * the CLI is for operators until the portal screens exist.
 */

export type PropertyErrorCode = "INVALID_INPUT" | "FORBIDDEN" | "GUARD" | "DUPLICATE" | "NOT_FOUND";

export class PropertyError extends Error {
  constructor(
    readonly code: PropertyErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PropertyError";
  }
}

type Db = pg.Pool | pg.ClientBase;

/** Maps the SQLSTATEs the property.* functions raise (see property.fail) to error codes. */
export function mapError(e: unknown): unknown {
  const err = e as { code?: string; message?: string };
  const code = err.code ?? "";
  const msg = err.message ?? "database error";
  if (code === "42501") return new PropertyError("FORBIDDEN", msg);
  if (code === "23514") return new PropertyError("GUARD", msg);
  if (code === "23505") return new PropertyError("DUPLICATE", msg);
  if (code === "P0002") return new PropertyError("NOT_FOUND", msg);
  if (code.startsWith("22") || code === "23503" || code === "23502") return new PropertyError("INVALID_INPUT", msg);
  return e;
}

// ------------------------------------------------------------------ schemas
const actor = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9@._:+-]{1,99}$/, "actor id: 2-100 characters");
const uuid = z.uuid();
const reason = z.string().trim().min(10).max(500);
const id = z.union([z.number().int().positive(), z.bigint().positive(), z.string().regex(/^[1-9][0-9]{0,18}$/)]).transform((v) => String(v));
const sha = z
  .string()
  .regex(/^[0-9a-f]{64}$/, "SHA-256 as 64 lower-case hex characters")
  .transform((h) => Buffer.from(h, "hex"));
const date = z.iso.date();
const paisa = z.union([z.bigint().nonnegative(), z.string().regex(/^[0-9]{1,18}$/)]).transform((v) => String(v));
const units = z.union([z.bigint().positive(), z.string().regex(/^[1-9][0-9]{0,29}$/)]).transform((v) => String(v));
const discipline = z.enum(["title", "encumbrance", "valuation", "legal_opinion", "technical"]);
const duty = z.enum(["onboarding", "compliance", "compliance_senior", "legal", "legal_head", "valuation", "technical", "ic_member", "ic_independent", "trustee"]);
const text = (min: number, max: number): z.ZodString => z.string().trim().min(min).max(max);
const opt = <T extends z.ZodType>(s: T): z.ZodOptional<z.ZodNullable<T>> => s.nullable().optional();

/** OB-10 identifiers; only these keys reach property.set_identifiers (which also refuses unknown keys). */
export const identifiersSchema = z.strictObject({
  province: opt(z.enum(PROVINCES)),
  district: opt(text(2, 60)),
  tehsil: opt(text(2, 60)),
  mauza: opt(text(1, 80)),
  society: opt(text(1, 120)),
  khewat: opt(text(1, 60)),
  khatooni: opt(text(1, 60)),
  khasra: opt(text(1, 200)),
  plot_no: opt(text(1, 40)),
  building: opt(text(1, 80)),
  floor: opt(text(1, 20)),
  unit_no: opt(text(1, 40)),
  sub_registrar: opt(text(2, 120)),
  deed_no: opt(text(1, 40)),
  deed_volume: opt(text(1, 20)),
  deed_page: opt(text(1, 20)),
  deed_date: opt(date),
  land_record_ref: opt(text(1, 80)),
  authority_file_no: opt(text(1, 80)),
  excise_no: opt(text(1, 80)),
  address: opt(text(5, 300)),
  land_area: opt(z.string().regex(/^[0-9]{1,10}$|^[0-9]{1,10}\.[0-9]{1,4}$/)),
  land_area_unit: opt(z.enum(["sq_ft", "sq_m", "marla", "kanal", "acre"])),
  covered_area_sqft: opt(z.string().regex(/^[0-9]{1,12}$|^[0-9]{1,12}\.[0-9]{1,2}$/)),
  gps_lat: opt(z.string().regex(/^-?[0-9]{1,2}\.[0-9]{1,6}$/)),
  gps_lon: opt(z.string().regex(/^-?[0-9]{1,3}\.[0-9]{1,6}$/)),
  use: opt(z.enum(["commercial", "residential", "mixed"])),
  built: opt(z.boolean()),
  occupancy: opt(z.enum(["vacant", "owner_occupied", "tenanted", "partly_tenanted"])),
  lease_count: opt(z.number().int().min(0).max(100_000)),
  monthly_rent_paisa: opt(paisa),
  declared_charges: opt(z.boolean()),
});
export type Identifiers = z.input<typeof identifiersSchema>;

interface Action<S extends z.ZodType, R> {
  schema: S;
  sql: string;
  params: (i: z.output<S>) => unknown[];
  result: (v: unknown) => R;
}

const act = <S extends z.ZodType, R>(schema: S, sql: string, params: (i: z.output<S>) => unknown[], result: (v: unknown) => R): Action<S, R> => ({
  schema,
  sql,
  params,
  result,
});
const asBig = (v: unknown): bigint => BigInt(String(v));
const asText = (v: unknown): string => String(v);
const asBool = (v: unknown): boolean => v === true;
const asInt = (v: unknown): number => Number(v);

export interface SubmitResult {
  submitted: boolean;
  checkId: number;
  outcome: "clear" | "possible" | "blocked";
  possible: number;
  fraud: boolean;
}

/**
 * Every operation of the S-01 workflow, as (input schema, SQL call). The service, the CLI and the
 * portal all go through runAction, so validation is the same everywhere.
 */
export const ACTIONS = {
  // ---- duties and the valuer panel (pt_property_admin)
  requestDuty: act(
    z.strictObject({ actor, duty, by: actor, reason }),
    "SELECT property.request_duty($1, $2, $3, $4) AS r",
    (i) => [i.actor, i.duty, i.by, i.reason],
    asBig,
  ),
  decideDuty: act(
    z.strictObject({ dutyId: id, by: actor, approve: z.boolean(), reason }),
    "SELECT property.decide_duty($1, $2, $3, $4) AS r",
    (i) => [i.dutyId, i.by, i.approve, i.reason],
    asText,
  ),
  revokeDuty: act(z.strictObject({ dutyId: id, by: actor, reason }), "SELECT property.revoke_duty($1, $2, $3) AS r", (i) => [i.dutyId, i.by, i.reason], asBool),
  addValuer: act(
    z.strictObject({ licence: text(2, 40), panel: z.string().regex(/^[a-z][a-z0-9_]{1,30}$/), subjectId: opt(uuid), actor }),
    "SELECT property.add_valuer($1, $2, $3, $4) AS r",
    (i) => [i.licence, i.panel, i.subjectId ?? null, i.actor],
    asBig,
  ),
  approveValuer: act(z.strictObject({ valuerId: id, actor }), "SELECT property.approve_valuer($1, $2) AS r", (i) => [i.valuerId, i.actor], asBool),

  // ---- sponsor KYB
  addPerson: act(
    z.strictObject({
      sponsorId: uuid,
      subjectId: uuid,
      role: z.enum(["director", "representative", "beneficial_owner"]),
      ownershipBp: opt(z.number().int().min(0).max(10_000)),
      control: opt(z.enum(["shares", "votes", "other_control"])),
      chainDepth: opt(z.number().int().min(1).max(10)),
      powers: opt(z.array(z.enum(["submit", "upload", "respond", "withdraw"])).min(1).max(4)),
      actor,
    }),
    "SELECT property.add_sponsor_person($1, $2, $3, $4, $5, $6::smallint, $7::text[], $8) AS r",
    (i) => [i.sponsorId, i.subjectId, i.role, i.ownershipBp ?? null, i.control ?? null, i.chainDepth ?? null, i.powers ?? null, i.actor],
    asBig,
  ),
  endPerson: act(z.strictObject({ personId: id, actor, reason }), "SELECT property.end_sponsor_person($1, $2, $3) AS r", (i) => [i.personId, i.actor, i.reason], asBool),
  recordRegistrationCheck: act(
    z.strictObject({ sponsorId: uuid, method: z.enum(["secp_eservices", "provider", "manual"]), outcome: z.enum(["verified", "mismatch", "not_found"]), evidence: sha, actor }),
    "SELECT property.record_registration_check($1, $2, $3, $4, $5) AS r",
    (i) => [i.sponsorId, i.method, i.outcome, i.evidence, i.actor],
    asBig,
  ),
  recordScreening: act(
    z.strictObject({
      sponsorId: uuid,
      provider: z.string().regex(/^[a-z][a-z0-9-]{2,39}$/),
      listVersion: z.string().regex(/^[A-Za-z0-9._-]{1,40}$/),
      outcome: z.enum(["clear", "possible_match", "hit"]),
      evidence: sha,
      actor,
    }),
    "SELECT property.record_screening($1, $2, $3, $4, $5, $6) AS r",
    (i) => [i.sponsorId, i.provider, i.listVersion, i.outcome, i.evidence, i.actor],
    asBig,
  ),
  recordRisk: act(
    z.strictObject({ sponsorId: uuid, rating: z.enum(["low", "medium", "high"]), reasons: reason, edd: opt(sha), actor }),
    "SELECT property.record_risk($1, $2, $3, $4, $5) AS r",
    (i) => [i.sponsorId, i.rating, i.reasons, i.edd ?? null, i.actor],
    asBig,
  ),
  recordFmu: act(
    z.strictObject({ sponsorId: uuid, outcome: z.enum(["no_grounds", "str_filed", "str_not_required"]), evidence: sha, actor }),
    "SELECT property.record_fmu($1, $2, $3, $4) AS r",
    (i) => [i.sponsorId, i.outcome, i.evidence, i.actor],
    asBig,
  ),
  submitKyb: act(z.strictObject({ sponsorId: uuid, actor, actingFor: id }), "SELECT property.submit_kyb($1, $2, $3) AS r", (i) => [i.sponsorId, i.actor, i.actingFor], asText),
  screenKyb: act(
    z.strictObject({ sponsorId: uuid, actor, accept: z.boolean(), reason: opt(reason) }),
    "SELECT property.screen_kyb($1, $2, $3, $4) AS r",
    (i) => [i.sponsorId, i.actor, i.accept, i.reason ?? null],
    asText,
  ),
  queryKyb: act(z.strictObject({ sponsorId: uuid, actor, query: reason }), "SELECT property.query_kyb($1, $2, $3) AS r", (i) => [i.sponsorId, i.actor, i.query], asText),
  suspendSponsor: act(z.strictObject({ sponsorId: uuid, actor, reason }), "SELECT property.suspend_sponsor($1, $2, $3) AS r", (i) => [i.sponsorId, i.actor, i.reason], asInt),
  expireSponsors: act(z.strictObject({ actor }), "SELECT property.expire_sponsors($1) AS r", (i) => [i.actor], asInt),

  // ---- maker-checker
  requestTransition: act(
    z.strictObject({
      entity: z.enum(["sponsor", "property"]),
      id: uuid,
      code: z.enum(["K4", "K5", "K10", "K11", "SC", "P6", "P13", "P14"]),
      officer: actor,
      reason,
      detail: opt(z.record(z.string().regex(/^[a-zA-Z]{1,30}$/), z.union([z.string().max(200), z.boolean(), z.number()]))),
    }),
    "SELECT property.request_transition($1, $2, $3, $4, $5, $6::jsonb) AS r",
    (i) => [i.entity, i.id, i.code, i.officer, i.reason, JSON.stringify(i.detail ?? {})],
    asBig,
  ),
  decideRequest: act(
    z.strictObject({ requestId: id, officer: actor, approve: z.boolean(), reason }),
    "SELECT property.decide_request($1, $2, $3, $4) AS r",
    (i) => [i.requestId, i.officer, i.approve, i.reason],
    asText,
  ),

  // ---- properties
  createProperty: act(
    z.strictObject({ sponsorId: uuid, actor, actingFor: id, previousId: opt(uuid), identifiers: identifiersSchema }),
    "SELECT property.create_property($1, $2, $3, $4, $5::jsonb) AS r",
    (i) => [i.sponsorId, i.actor, i.actingFor, i.previousId ?? null, JSON.stringify(i.identifiers)],
    asText,
  ),
  updateProperty: act(
    z.strictObject({ propertyId: uuid, actor, actingFor: id, identifiers: identifiersSchema }),
    "SELECT property.update_property($1, $2, $3, $4::jsonb) AS r",
    (i) => [i.propertyId, i.actor, i.actingFor, JSON.stringify(i.identifiers)],
    (v) => v as string[],
  ),
  submitProperty: act(
    z.strictObject({ propertyId: uuid, actor, actingFor: id }),
    "SELECT property.submit_property($1, $2, $3) AS r",
    (i) => [i.propertyId, i.actor, i.actingFor],
    (v) => v as SubmitResult,
  ),
  withdrawProperty: act(
    z.strictObject({ propertyId: uuid, actor, actingFor: id, reason }),
    "SELECT property.withdraw_property($1, $2, $3, $4) AS r",
    (i) => [i.propertyId, i.actor, i.actingFor, i.reason],
    asText,
  ),
  returnProperty: act(z.strictObject({ propertyId: uuid, officer: actor, reason }), "SELECT property.return_property($1, $2, $3) AS r", (i) => [i.propertyId, i.officer, i.reason], asText),
  decideDuplicate: act(
    z.strictObject({ candidateId: id, officer: actor, capacity: z.enum(["onboarding", "compliance"]), decision: z.enum(["clear", "confirm"]), reason }),
    "SELECT property.decide_duplicate($1, $2, $3, $4, $5) AS r",
    (i) => [i.candidateId, i.officer, i.capacity, i.decision, i.reason],
    asText,
  ),
  startReview: act(
    z.strictObject({ propertyId: uuid, officer: actor, legal: actor, valuation: actor, technical: actor }),
    "SELECT property.start_review($1, $2, $3, $4, $5) AS r",
    (i) => [i.propertyId, i.officer, i.legal, i.valuation, i.technical],
    asText,
  ),
  reassignReviewer: act(
    z.strictObject({ propertyId: uuid, officer: actor, group: z.enum(["legal", "valuation", "technical"]), reviewer: actor }),
    "SELECT property.reassign_reviewer($1, $2, $3, $4) AS r",
    (i) => [i.propertyId, i.officer, i.group, i.reviewer],
    asBig,
  ),
  queryProperty: act(z.strictObject({ propertyId: uuid, reviewer: actor, query: reason }), "SELECT property.query_property($1, $2, $3) AS r", (i) => [i.propertyId, i.reviewer, i.query], asText),
  holdProperty: act(z.strictObject({ propertyId: uuid, actor, reason }), "SELECT property.hold_property($1, $2, $3) AS r", (i) => [i.propertyId, i.actor, i.reason], asText),
  reopen: act(
    z.strictObject({ propertyId: uuid, actor, disciplines: z.array(discipline).min(1).max(5), reason }),
    "SELECT property.reopen($1, $2, $3::text[], $4) AS r",
    (i) => [i.propertyId, i.actor, i.disciplines, i.reason],
    asText,
  ),

  // ---- documents (metadata only; the file is in the encrypted store)
  addDocument: act(
    z.strictObject({
      sponsorId: uuid,
      propertyId: opt(uuid),
      docType: z.string().regex(/^[a-z][a-z_]{2,40}$/),
      sha256: sha,
      sizeBytes: z.number().int().min(1).max(1_073_741_824),
      mediaType: z.enum(["application/pdf", "image/jpeg", "image/png", "image/tiff"]),
      storeRef: z.string().regex(/^[a-z][a-z0-9+.-]{1,19}:\/\/[A-Za-z0-9._~/-]{1,200}$/),
      actor,
      actingFor: opt(id),
      supersedes: opt(uuid),
    }),
    "SELECT property.add_document($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) AS r",
    (i) => [i.sponsorId, i.propertyId ?? null, i.docType, i.sha256, i.sizeBytes, i.mediaType, i.storeRef, i.actor, i.actingFor ?? null, i.supersedes ?? null],
    asText,
  ),
  verifyDocument: act(
    z.strictObject({
      documentId: uuid,
      actor,
      method: z.enum(["in_person", "online_portal", "official_letter", "provider"]),
      office: text(2, 120),
      verifiedOn: date,
      outcome: z.enum(["verified", "failed"]),
      evidence: sha,
    }),
    "SELECT property.verify_document($1, $2, $3, $4, $5::date, $6, $7) AS r",
    (i) => [i.documentId, i.actor, i.method, i.office, i.verifiedOn, i.outcome, i.evidence],
    asBig,
  ),

  // ---- due diligence
  addTitleLink: act(
    z.strictObject({
      propertyId: uuid,
      actor,
      position: z.number().int().min(1).max(200),
      kind: z.enum(["grant", "allotment", "sale_deed", "gift_deed", "mutation", "inheritance", "lease", "transfer_letter", "decree"]),
      instrumentRef: text(1, 80),
      registeredOn: date,
      documentId: uuid,
    }),
    "SELECT property.add_title_link($1, $2, $3::smallint, $4, $5, $6::date, $7) AS r",
    (i) => [i.propertyId, i.actor, i.position, i.kind, i.instrumentRef, i.registeredOn, i.documentId],
    asBig,
  ),
  recordEncumbrance: act(
    z.strictObject({
      propertyId: uuid,
      actor,
      kind: z.enum(["mortgage", "charge", "lien", "attachment", "stay_order", "litigation", "acquisition_notice", "unpaid_tax", "other"]),
      description: reason,
      evidence: sha,
    }),
    "SELECT property.record_encumbrance($1, $2, $3, $4, $5) AS r",
    (i) => [i.propertyId, i.actor, i.kind, i.description, i.evidence],
    asBig,
  ),
  resolveEncumbrance: act(
    z.strictObject({ encumbranceId: id, actor, resolution: z.enum(["discharged", "condition_precedent"]), note: reason, evidence: sha }),
    "SELECT property.resolve_encumbrance($1, $2, $3, $4, $5) AS r",
    (i) => [i.encumbranceId, i.actor, i.resolution, i.note, i.evidence],
    asBig,
  ),
  recordValuation: act(
    z.strictObject({ propertyId: uuid, actor, valuerId: id, valuePaisa: paisa, valuedOn: date, reportId: uuid, independence: sha }),
    "SELECT property.record_valuation($1, $2, $3, $4::bigint, $5::date, $6, $7) AS r",
    (i) => [i.propertyId, i.actor, i.valuerId, i.valuePaisa, i.valuedOn, i.reportId, i.independence],
    asBig,
  ),
  recordReview: act(
    z.strictObject({
      propertyId: uuid,
      reviewer: actor,
      discipline,
      scope: text(10, 500),
      method: text(10, 500),
      findings: text(10, 2000),
      conditions: z.array(text(3, 300)).max(50).default([]),
      decision: z.enum(["pass", "pass_with_conditions", "fail"]),
      documents: z.array(uuid).min(1).max(200),
    }),
    "SELECT property.record_review($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9::uuid[]) AS r",
    (i) => [i.propertyId, i.reviewer, i.discipline, i.scope, i.method, i.findings, JSON.stringify(i.conditions), i.decision, i.documents],
    asBig,
  ),

  // ---- committee, structure, trustee
  openIc: act(z.strictObject({ propertyId: uuid, chair: actor }), "SELECT property.open_ic($1, $2) AS r", (i) => [i.propertyId, i.chair], asBig),
  castVote: act(
    z.strictObject({ meetingId: id, member: actor, vote: opt(z.enum(["approve", "reject", "abstain"])), conflictNote: opt(reason) }),
    "SELECT property.cast_vote($1, $2, $3, $4) AS r",
    (i) => [i.meetingId, i.member, i.vote ?? null, i.conflictNote ?? null],
    asBig,
  ),
  closeIc: act(z.strictObject({ meetingId: id, chair: actor, minutes: sha }), "SELECT property.close_ic($1, $2, $3) AS r", (i) => [i.meetingId, i.chair, i.minutes], asText),
  recordStructure: act(
    z.strictObject({
      propertyId: uuid,
      actor,
      kind: z.enum(["reit", "spv"]),
      shariah: z.boolean(),
      unitRights: z.strictObject({ income: text(2, 300), exit: text(2, 300), voting: text(2, 300), information: text(2, 300) }),
      plannedUnits: units,
      trustDeedId: uuid,
    }),
    "SELECT property.record_structure($1, $2, $3, $4, $5::jsonb, $6::numeric, $7) AS r",
    (i) => [i.propertyId, i.actor, i.kind, i.shariah, JSON.stringify(i.unitRights), i.plannedUnits, i.trustDeedId],
    asBig,
  ),
  trusteeDecide: act(
    z.strictObject({ propertyId: uuid, trustee: actor, structureId: id, accept: z.boolean(), conditions: opt(text(10, 1000)), reason }),
    "SELECT property.trustee_decide($1, $2, $3, $4, $5, $6) AS r",
    (i) => [i.propertyId, i.trustee, i.structureId, i.accept, i.conditions ?? null, i.reason],
    asText,
  ),
} as const;

export type ActionName = keyof typeof ACTIONS;
export type ActionInput<K extends ActionName> = z.input<(typeof ACTIONS)[K]["schema"]>;
export type ActionResult<K extends ActionName> = ReturnType<(typeof ACTIONS)[K]["result"]>;

export function isAction(name: string): name is ActionName {
  return Object.hasOwn(ACTIONS, name);
}

/** Validates the input and runs one operation; database refusals become PropertyError. */
export async function runAction<K extends ActionName>(db: Db, name: K, input: ActionInput<K>): Promise<ActionResult<K>> {
  // eslint-disable-next-line security/detect-object-injection -- name is a key of the fixed ACTIONS table
  const a = ACTIONS[name] as unknown as Action<z.ZodType, ActionResult<K>>;
  const parsed = a.schema.safeParse(input);
  if (!parsed.success) throw new PropertyError("INVALID_INPUT", z.prettifyError(parsed.error));
  try {
    const { rows } = await db.query<{ r: unknown }>(a.sql, a.params(parsed.data));
    return a.result(rows[0]?.r);
  } catch (e) {
    throw mapError(e);
  }
}

// ------------------------------------------------------------------ sponsors (sealing and hashing)
const createSponsorSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("company"),
    legalName: text(2, 200),
    address: text(5, 400),
    cuin: z.string().min(5).max(30),
    ntn: opt(z.string().min(5).max(30)),
    strn: opt(z.string().min(5).max(30)),
    actor,
  }),
  z.strictObject({
    kind: z.literal("individual"),
    ownerSubjectId: uuid,
    address: text(5, 400),
    ntn: opt(z.string().min(5).max(30)),
    actor,
  }),
]);
export type CreateSponsorInput = z.input<typeof createSponsorSchema>;

export interface SponsorOverview {
  sponsorId: string;
  kind: "company" | "individual";
  state: string;
  cuinLast4: string | null;
  ntnLast4: string | null;
  kybValidUntil: Date | null;
}

export interface PropertyOverview {
  propertyId: string;
  sponsorId: string;
  previousId: string | null;
  state: string;
  province: string | null;
  district: string | null;
  propertyKey: string | null;
  submittedAt: Date | null;
  stateSince: Date | null;
}

export class PropertyService {
  constructor(
    private readonly db: pg.Pool,
    private readonly secrets: SponsorSecrets,
  ) {}

  run<K extends ActionName>(name: K, input: ActionInput<K>): Promise<ActionResult<K>> {
    return runAction(this.db, name, input);
  }

  /** Creates a sponsor: registration numbers become keyed hashes, the name and address are sealed (PR-1). */
  async createSponsor(input: CreateSponsorInput): Promise<string> {
    const parsed = createSponsorSchema.safeParse(input);
    if (!parsed.success) throw new PropertyError("INVALID_INPUT", z.prettifyError(parsed.error));
    const i = parsed.data;
    const sponsorId = randomUUID();
    const ids: { kind: RegistrationKind; value: string }[] = [];
    try {
      if (i.kind === "company") ids.push({ kind: "cuin", value: i.cuin });
      if (i.ntn) ids.push({ kind: "ntn", value: i.ntn });
      if (i.kind === "company" && i.strn) ids.push({ kind: "strn", value: i.strn });
      for (const x of ids) x.value = normalizeRegistration(x.kind, x.value);
    } catch (e) {
      throw new PropertyError("INVALID_INPUT", (e as Error).message);
    }
    const hashes = ids.flatMap((x) => this.secrets.hashAll(x.kind, x.value).map((h) => ({ kind: x.kind, ...h })));
    const last4 = (k: RegistrationKind): string | null => ids.find((x) => x.kind === k)?.value.slice(-4) ?? null;
    try {
      await this.db.query("SELECT property.create_sponsor($1, $2, $3, $4, $5, $6::bytea[], $7::text[], $8::smallint[], $9, $10, $11)", [
        sponsorId,
        i.kind,
        i.kind === "individual" ? i.ownerSubjectId : null,
        i.kind === "company" ? this.secrets.seal(sponsorId, "name", i.legalName) : null,
        this.secrets.seal(sponsorId, "address", i.address),
        hashes.map((h) => h.hash),
        hashes.map((h) => h.kind),
        hashes.map((h) => h.version),
        last4("cuin"),
        last4("ntn"),
        i.actor,
      ]);
    } catch (e) {
      throw mapError(e);
    }
    return sponsorId;
  }

  /** The sponsor with this registration number, under any active pepper. */
  async findSponsor(kind: RegistrationKind, value: string): Promise<string | null> {
    let hashes: Buffer[];
    try {
      hashes = this.secrets.hashAll(kind, value).map((h) => h.hash);
    } catch (e) {
      throw new PropertyError("INVALID_INPUT", (e as Error).message);
    }
    const { rows } = await this.db.query<{ id: string | null }>("SELECT property.find_sponsor($1::bytea[]) AS id", [hashes]);
    return rows[0]?.id ?? null;
  }

  /** Opens the sealed legal name and address (portal display; never logged). */
  async sponsorDetails(sponsorId: string): Promise<{ kind: string; legalName: string | null; address: string } | null> {
    const { rows } = await this.db.query<{ kind: string; legal_name_enc: Buffer | null; address_enc: Buffer }>("SELECT * FROM property.sealed_sponsor($1)", [sponsorId]);
    const r = rows[0];
    if (!r) return null;
    return {
      kind: r.kind,
      legalName: r.legal_name_enc ? this.secrets.unseal(sponsorId, "name", r.legal_name_enc) : null,
      address: this.secrets.unseal(sponsorId, "address", r.address_enc),
    };
  }
}

// ------------------------------------------------------------------ reads (portal and CLI)
export async function sponsorOverview(db: Db, sponsorId: string): Promise<SponsorOverview | null> {
  const { rows } = await db.query<{ sponsor_id: string; kind: "company" | "individual"; state: string; cuin_last4: string | null; ntn_last4: string | null; kyb_valid_until: Date | null }>(
    "SELECT * FROM property.sponsor_overview WHERE sponsor_id = $1",
    [sponsorId],
  );
  const r = rows[0];
  return r ? { sponsorId: r.sponsor_id, kind: r.kind, state: r.state, cuinLast4: r.cuin_last4, ntnLast4: r.ntn_last4, kybValidUntil: r.kyb_valid_until } : null;
}

export async function propertyOverview(db: Db, propertyId: string): Promise<PropertyOverview | null> {
  const { rows } = await db.query<{
    property_id: string;
    sponsor_id: string;
    previous_id: string | null;
    state: string;
    province: string | null;
    district: string | null;
    property_key: string | null;
    submitted_at: Date | null;
    state_since: Date | null;
  }>("SELECT * FROM property.property_overview WHERE property_id = $1", [propertyId]);
  const r = rows[0];
  return r
    ? {
        propertyId: r.property_id,
        sponsorId: r.sponsor_id,
        previousId: r.previous_id,
        state: r.state,
        province: r.province,
        district: r.district,
        propertyKey: r.property_key,
        submittedAt: r.submitted_at,
        stateSince: r.state_since,
      }
    : null;
}

export async function sponsorState(db: Db, sponsorId: string): Promise<string | null> {
  const { rows } = await db.query<{ s: string | null }>("SELECT property.sponsor_state($1) AS s", [sponsorId]);
  return rows[0]?.s ?? null;
}

export async function reviewStatus(db: Db, propertyId: string): Promise<{ discipline: string; reviewId: string | null; reviewer: string | null; decision: string | null; fresh: boolean }[]> {
  const { rows } = await db.query<{ discipline: string; review_id: string | null; reviewer: string | null; decision: string | null; fresh: boolean }>(
    "SELECT * FROM property.review_status($1)",
    [propertyId],
  );
  return rows.map((r) => ({ discipline: r.discipline, reviewId: r.review_id, reviewer: r.reviewer, decision: r.decision, fresh: r.fresh }));
}

export async function valuationStatus(db: Db, propertyId: string): Promise<{ ok: boolean; problem: string | null; valuations: number; lowestPaisa: bigint | null }> {
  const { rows } = await db.query<{ ok: boolean; problem: string | null; valuations: number; lowest_paisa: string | null }>(
    "SELECT * FROM property.valuation_status($1)",
    [propertyId],
  );
  const r = rows[0];
  return { ok: r?.ok ?? false, problem: r?.problem ?? null, valuations: r?.valuations ?? 0, lowestPaisa: r?.lowest_paisa ? BigInt(r.lowest_paisa) : null };
}

/** Preview of the duplicate check (the binding check runs inside submit_property). */
export async function findDuplicates(db: Db, propertyId: string): Promise<{ candidate: string; kind: string; reasons: string[]; fraud: boolean }[]> {
  const { rows } = await db.query<{ candidate: string; kind: string; reasons: string[]; fraud: boolean }>("SELECT * FROM property.find_duplicates($1)", [propertyId]);
  return rows;
}

export interface QueueItem {
  kind: "request" | "possible_duplicate" | "blocked_submission";
  id: string;
  entityId: string;
  what: string;
  since: Date;
}

/** Work waiting for officers: open maker-checker requests, undecided possible duplicates, blocked submissions (cases). */
export async function workQueue(db: Db): Promise<QueueItem[]> {
  const { rows } = await db.query<{ kind: QueueItem["kind"]; id: string; entity_id: string; what: string; since: Date }>(`
    SELECT 'request' AS kind, r.id::text AS id, r.entity_id::text AS entity_id, r.code || ' requested by ' || r.requested_by AS what, r.requested_at AS since
      FROM property.requests r WHERE r.status = 'open' AND r.expires_at > now()
    UNION ALL
    SELECT 'possible_duplicate', c.id::text, k.property_id::text, array_to_string(c.reasons, ', ') || ' vs ' || c.candidate_id, k.at
      FROM property.duplicate_candidates c JOIN property.duplicate_checks k ON k.id = c.check_id
      JOIN property.properties p ON p.id = k.property_id AND p.state = 'submitted'
      WHERE c.kind = 'possible' AND k.id = (SELECT max(x.id) FROM property.duplicate_checks x WHERE x.property_id = k.property_id)
        AND property.candidate_status(c.id) = 'open'
    UNION ALL
    SELECT 'blocked_submission', k.id::text, k.property_id::text, CASE WHEN k.fraud THEN 'exact duplicate of a tokenized property (fraud indicator)' ELSE 'exact duplicate' END, k.at
      FROM property.duplicate_checks k WHERE k.outcome = 'blocked'
    ORDER BY since`);
  return rows.map((r) => ({ kind: r.kind, id: r.id, entityId: r.entity_id, what: r.what, since: r.since }));
}

export async function verifyAudit(db: Db): Promise<{ auditId: string | null; problem: string }[]> {
  const { rows } = await db.query<{ audit_id: string | null; problem: string }>("SELECT audit_id::text, problem FROM property.verify_audit()");
  return rows.map((r) => ({ auditId: r.audit_id, problem: r.problem }));
}
