import { db } from "./db";

/**
 * T-046 reads (migration 0026): investment committees, the trustee's P8 acceptance and platform
 * votes on S-02 requests. Each function is one call of an admin.* database function that checks the
 * session and permission itself. No personal data: building identifiers, states, hashes, handles.
 */

export interface PropertyRef {
  id: string;
  state: string;
  province: string | null;
  district: string | null;
  building: string | null;
  use: string | null;
  propertyKey: string | null;
  sponsorState: string | null;
}

export interface CommitteeRow {
  id: number;
  status: string;
  chair: string;
  openedAt: string;
  closedAt: string | null;
  property: PropertyRef;
  votes: number;
  quorum: boolean | null;
  mine: boolean;
  chairIsMe: boolean;
}

export interface Committees {
  at: string;
  quorum: number;
  open: CommitteeRow[];
  ready: { property: PropertyRef; openBlockers: string[] }[];
  recent: CommitteeRow[];
}

export interface Doc {
  id: string;
  type: string;
  sha256: string;
  uploadedAt: string;
}

export interface Committee {
  id: number;
  status: string;
  chair: string;
  openedAt: string;
  closedAt: string | null;
  minutesSha256: string | null;
  acceptedQualifications: unknown;
  property: PropertyRef;
  reviews: { discipline: string; review: number | null; reviewer: string | null; decision: string | null; fresh: boolean }[];
  qualifications: unknown[] | null;
  valuation: { ok: boolean; problem: string | null; count: number; lowestPaisa: string | null };
  documents: Doc[];
  p7Problem: string | null;
  votes: { member: string; independent: boolean; conflict: boolean; conflictNote: string | null; vote: string | null; at: string; reason: string | null }[];
  outcome: { quorum: boolean; approved: boolean; voters: number; approvals: number; needed: number };
  digest: string;
  closeDigest: string;
  chairIsMe: boolean;
  blockers: string[];
  closeBlockers: string[];
}

export interface TrusteeProperties {
  at: string;
  waiting: {
    property: PropertyRef;
    structure: { id: number; kind: string; shariah: boolean; plannedUnits: string; decidedBy: string; at: string; decided: boolean } | null;
    since: string | null;
    blockers: string[];
  }[];
  recent: { id: number; property: PropertyRef; structure: number; trustee: string; decision: string; reason: string; at: string }[];
}

export interface TrusteeProperty {
  property: PropertyRef;
  structure: {
    id: number;
    kind: string;
    shariah: boolean;
    unitRights: Record<string, string>;
    plannedUnits: string;
    maxBalanceBp: number;
    maxHoldingUnits: string;
    decidedBy: string;
    at: string;
    trustDeed: { id: string; type: string; sha256: string; current: boolean } | null;
  } | null;
  committee: { id: number; chair: string; closedAt: string; minutesSha256: string; acceptedQualifications: unknown; votes: number; approvals: number } | null;
  valuation: { ok: boolean; problem: string | null; count: number; lowestPaisa: string | null };
  documents: Doc[];
  decisions: { id: number; structure: number; trustee: string; decision: string; conditions: string | null; reason: string; at: string }[];
  digest: string;
  blockers: string[];
  acceptBlockers: string[];
}

export interface OfferingVotes {
  at: string;
  open: {
    id: number;
    code: string;
    offering: string;
    offeringState: string;
    requestedBy: string;
    requestedAt: string;
    expiresAt: string | null;
    expired: boolean | null;
    note: string;
    property: PropertyRef | null;
    missing: string[];
    votes: number;
    mine: boolean;
  }[];
  lapsed: { request: number; offering: string; status: string; property: PropertyRef | null }[];
  recent: { request: number; officer: string; duty: string; approve: boolean; at: string }[];
}

export interface OfferingTerms {
  id: string;
  state: string;
  token: string | null;
  createdBy: string;
  priceRupees: string | null;
  pricePaisa: string | null;
  minRaiseUnits: string | null;
  targetUnits: string | null;
  hardCapUnits: string | null;
  minUnits: string | null;
  maxUnits: string | null;
  opensAt: string | null;
  closesAt: string | null;
  paymentGraceMinutes: number | null;
  reservationMinutes: number | null;
  completionDays: number | null;
  categories: string[];
  useOfProceeds: { line: string; paisa: string }[] | null;
  docEnSha256: string | null;
  docUrSha256: string | null;
  riskSha256: string | null;
  registerUnits: string | null;
  maxHoldingUnits: string | null;
  trusteeCap: string | null;
  supply: string | null;
}

export interface OfferingVoteRequest {
  id: number;
  code: string;
  note: string;
  needs: string[];
  status: string;
  offeringState: string;
  subscription: string | null;
  requestedBy: string;
  reason: string;
  detail: Record<string, unknown>;
  requestedAt: string;
  expiresAt: string | null;
  decidedAt: string | null;
  expired: boolean | null;
  offering: OfferingTerms;
  property: PropertyRef | null;
  missing: string[];
  votes: { officer: string; duty: string; approve: boolean; reason: string; at: string }[];
  problem: string | null;
  digest: string;
  blockers: string[];
  approveBlockers: string[];
  returnBlockers: string[];
}

async function one<T>(sql: string, params: unknown[]): Promise<T | null> {
  const { rows } = await db().query<{ v: T | null }>(sql, params);
  return rows[0]?.v ?? null;
}

async function must<T>(sql: string, params: unknown[], what: string): Promise<T> {
  const v = await one<T>(sql, params);
  if (!v) throw new Error(`no ${what}`);
  return v;
}

export const committees = (sessionHash: Buffer): Promise<Committees> => must<Committees>("SELECT admin.committees($1) AS v", [sessionHash], "committee list");
export const committee = (sessionHash: Buffer, id: string): Promise<Committee | null> => one<Committee>("SELECT admin.committee($1, $2) AS v", [sessionHash, id]);
export const trusteeProperties = (sessionHash: Buffer): Promise<TrusteeProperties> =>
  must<TrusteeProperties>("SELECT admin.trustee_properties($1) AS v", [sessionHash], "property list");
export const trusteeProperty = (sessionHash: Buffer, id: string): Promise<TrusteeProperty | null> =>
  one<TrusteeProperty>("SELECT admin.trustee_property($1, $2) AS v", [sessionHash, id]);
export const offeringVotes = (sessionHash: Buffer): Promise<OfferingVotes> => must<OfferingVotes>("SELECT admin.offering_votes($1) AS v", [sessionHash], "offering list");
export const offeringVoteRequest = (sessionHash: Buffer, id: string): Promise<OfferingVoteRequest | null> =>
  one<OfferingVoteRequest>("SELECT admin.offering_vote_request($1, $2) AS v", [sessionHash, id]);

/** A property's name as officers know it: the building, then its district. */
export function propertyName(p: PropertyRef | null | undefined): string {
  if (!p) return "–";
  return [p.building, p.district].filter((x): x is string => Boolean(x)).join(", ") || p.id.slice(0, 8);
}

const DUTY_LABELS = new Map<string, string>([
  ["offering", "offering checker (terms)"],
  ["legal_head", "legal head (documents)"],
  ["compliance", "compliance (eligibility, disclosures)"],
  ["bank_operator", "bank operator"],
  ["trustee", "trustee"],
]);

export function dutyLabel(d: string): string {
  return DUTY_LABELS.get(d) ?? d;
}

const VOTES = new Map<string, string>([
  ["approve", "approve"],
  ["reject", "reject"],
  ["abstain", "abstain"],
]);

export function voteLabel(v: { conflict: boolean; vote: string | null }): string {
  return v.conflict ? "conflict recorded (no vote)" : (VOTES.get(v.vote ?? "") ?? "–");
}

/** Paisa as rupees with en-PK grouping (string in, string out). */
export function rupees(paisa: string | null | undefined): string {
  if (!paisa || !/^\d+$/.test(paisa)) return "–";
  const r = paisa.length > 2 ? paisa.slice(0, -2) : "0";
  const p = paisa.padStart(3, "0").slice(-2);
  const groups: string[] = [];
  for (let end = r.length; end > 0; end -= 3) groups.unshift(r.slice(Math.max(0, end - 3), end));
  return `Rs ${groups.join(",")}${p === "00" ? "" : `.${p}`}`;
}
