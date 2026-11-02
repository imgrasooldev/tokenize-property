import { db } from "./db";

/**
 * The onboarding desk (S-01 maker screens, migration 0049): the work queue, sponsor and property
 * files with their evidence, and the S-01 duties and valuer panel. Sealed names and addresses never
 * reach the portal (only the last four digits of the registration numbers).
 */
export interface QueueItem {
  kind: "request" | "possible_duplicate" | "blocked_submission";
  id: number;
  entity: "sponsor" | "property";
  entityId: string;
  what: string;
  since: string;
}

export interface SponsorRow {
  id: string;
  kind: "company" | "individual";
  state: string;
  cuinLast4: string | null;
  ntnLast4: string | null;
  kybValidUntil: string | null;
  properties: number;
  createdAt: string;
}

export interface PropertyRow {
  id: string;
  state: string;
  province: string | null;
  district: string | null;
  building: string | null;
  use: string | null;
  propertyKey: string | null;
  sponsorState: string | null;
  sponsorId: string;
  stateSince: string | null;
}

export interface Duty {
  id: number;
  officer: string;
  duty: string;
  status: "pending" | "active";
  requestedBy: string;
  requestedAt: string;
  reason: string;
  decidedBy: string | null;
}

export interface Valuer {
  id: number;
  licence: string;
  panel: string;
  addedBy: string;
  approvedBy: string | null;
}

export interface Desk {
  me: { handle: string; duties: string[] };
  queue: QueueItem[];
  sponsors: SponsorRow[];
  properties: PropertyRow[];
  duties: Duty[];
  valuers: Valuer[];
}

export interface FileEvent {
  code: string;
  from: string;
  to: string;
  actor: string;
  actingFor: number | null;
  reason: string | null;
  checker: string | null;
  at: string;
}

export interface FileDocument {
  id: string;
  type: string;
  sha256: string;
  sizeBytes: number;
  mediaType: string;
  uploadedAt: string;
  verifications: number;
}

export interface VaultFile {
  sha256: string;
  sizeBytes: number;
  mediaType: string;
  by: string;
  at: string;
}

export interface SponsorFile {
  id: string;
  kind: "company" | "individual";
  state: string;
  cuinLast4: string | null;
  ntnLast4: string | null;
  kybValidUntil: string | null;
  createdAt: string;
  people: { id: number; subject: string; role: string; ownershipBp: number | null; control: string | null; chainDepth: number | null; powers: string[] | null; addedBy: string; addedAt: string }[];
  registrationChecks: { method: string; outcome: string; by: string; at: string }[];
  screenings: { provider: string; listVersion: string; outcome: string; basis: string; by: string; at: string }[];
  risk: { rating: string; reasons: string; edd: boolean; by: string; at: string }[];
  fmu: { outcome: string; by: string; at: string }[];
  documents: FileDocument[];
  properties: Omit<PropertyRow, "sponsorId" | "stateSince">[];
  events: FileEvent[];
  vault: VaultFile[];
}

export interface PropertyFile extends Omit<PropertyRow, "stateSince"> {
  previousId: string | null;
  occupancy: string | null;
  built: boolean | null;
  submittedAt: string | null;
  stateSince: string | null;
  sponsorPeople: { id: number; role: string; powers: string[] }[];
  reviews: { discipline: string; reviewId: number | null; reviewer: string | null; decision: string | null; fresh: boolean }[];
  assignments: { group: string; reviewer: string; by: string; at: string }[];
  valuation: { ok: boolean; problem: string | null; valuations: number; lowestPaisa: string | null } | null;
  valuations: { id: number; valuer: string; valuePaisa: string; on: string; by: string }[];
  candidates: { id: number; candidate: string; kind: string; reasons: string[]; status: string }[];
  documents: FileDocument[];
  titleLinks: { position: number; kind: string; ref: string; on: string; document: string; by: string }[];
  encumbrances: { id: number; kind: string; description: string; by: string; at: string; resolution: string | null; resolvedBy: string | null }[];
  structure: { id: number; kind: string; shariah: boolean; rights: Record<string, string>; plannedUnits: string; maxHoldingUnits: string; by: string; at: string } | null;
  valuers: { id: number; licence: string; panel: string }[];
  events: FileEvent[];
  vault: VaultFile[];
}

export interface DutyPanel {
  duties: Duty[];
  valuers: Valuer[];
  dutyRoles: Record<string, string[]>;
}

async function one<T>(sql: string, params: unknown[]): Promise<T | null> {
  const { rows } = await db().query<{ v: T | null }>(sql, params);
  return rows[0]?.v ?? null;
}

export async function desk(sessionHash: Buffer): Promise<Desk> {
  return (await one<Desk>("SELECT admin.onboarding($1) AS v", [sessionHash])) ?? { me: { handle: "", duties: [] }, queue: [], sponsors: [], properties: [], duties: [], valuers: [] };
}

export function sponsorFile(sessionHash: Buffer, id: string): Promise<SponsorFile | null> {
  return one<SponsorFile>("SELECT admin.onboarding_sponsor($1, $2) AS v", [sessionHash, id]);
}

export function propertyFile(sessionHash: Buffer, id: string): Promise<PropertyFile | null> {
  return one<PropertyFile>("SELECT admin.onboarding_property($1, $2) AS v", [sessionHash, id]);
}

export async function dutyPanel(sessionHash: Buffer): Promise<DutyPanel> {
  return (await one<DutyPanel>("SELECT admin.property_duties($1) AS v", [sessionHash])) ?? { duties: [], valuers: [], dutyRoles: {} };
}

export const DUTIES = ["onboarding", "compliance", "compliance_senior", "legal", "legal_head", "valuation", "technical", "ic_member", "ic_independent", "trustee"] as const;
export const DISCIPLINES = ["title", "encumbrance", "valuation", "legal_opinion", "technical"] as const;
export const ID_FIELDS = [
  "province",
  "district",
  "society",
  "plot_no",
  "mauza",
  "khasra",
  "building",
  "sub_registrar",
  "deed_no",
  "deed_date",
  "land_record_ref",
  "excise_no",
  "land_area",
  "land_area_unit",
  "gps_lat",
  "gps_lon",
  "use",
  "occupancy",
] as const;

export function fileName(p: { building: string | null; district: string | null; propertyKey?: string | null; id: string }): string {
  return p.building ?? ([p.district, p.propertyKey].filter(Boolean).join(" · ") || p.id.slice(0, 8));
}

export function rupeesOfPaisa(paisa: string | null): string {
  if (!paisa) return "–";
  const n = BigInt(paisa);
  return `Rs ${(n / 100n).toLocaleString("en-US")}`;
}
