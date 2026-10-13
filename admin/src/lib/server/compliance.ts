import { db } from "./db";

/**
 * Step 6c reads (compliance officers and auditors). Every function here is one call of an admin.*
 * database function (migration 0019) that checks the session and compliance.read itself. Shapes
 * mirror the jsonb those functions build. No name, CNIC (only its last four digits, masked), IBAN or
 * phone number is ever returned; wallets are pseudonymous addresses.
 */

export interface SubjectView {
  id: string;
  ref: string;
  cnic: string;
  status: string;
  underlyingStatus: string;
  wallet: string | null;
  decisionReason: string | null;
  validUntil: string | null;
  since: string;
  hold: { id: number; freezeRequest: number; placedAt: string } | null;
}

export interface Dashboard {
  at: string;
  kycStatus: Record<string, number>;
  kycCases: Record<string, number>;
  highRiskOpen: number;
  freezes: Record<string, number>;
  activeHolds: number;
  str: Record<string, number>;
  rescreens: Record<string, number>;
  breaches: { kind: "kyc" | "freeze" | "str" | "rescreen"; id: number; state: string; risk: string; since: string; sla: string; overdueSeconds: number }[];
  oldestOpen: { kyc: string | null; freeze: string | null; str: string | null };
  recent: { kind: string; id: number; action: string; to: string; actor: string; at: string }[];
}

export async function dashboard(sessionHash: Buffer): Promise<Dashboard> {
  const { rows } = await db().query<{ v: Dashboard }>("SELECT admin.compliance_dashboard($1) AS v", [sessionHash]);
  const v = rows[0]?.v;
  if (!v) throw new Error("no dashboard");
  return v;
}

export interface QueueRow {
  id: number;
  kind: string;
  risk: "standard" | "high";
  flags: string[];
  status: string;
  subject: string;
  cnic: string;
  openedAt: string;
  updatedAt: string;
  proposal: string | null;
  proposedBy: string | null;
  waitingForMe: boolean;
  overdue: boolean;
}

export const CASE_STATES = ["open", "info_requested", "pending_second", "approved", "rejected", "superseded"] as const;

export async function kycQueue(sessionHash: Buffer, status: string | null): Promise<QueueRow[]> {
  const { rows } = await db().query<{ v: QueueRow[] }>("SELECT admin.kyc_queue($1, $2) AS v", [sessionHash, status]);
  return rows[0]?.v ?? [];
}

export type CaseAction = "request_info" | "info_received" | "escalate" | "approve" | "reject" | "confirm" | "decline";
export const CASE_ACTIONS: readonly CaseAction[] = ["request_info", "info_received", "escalate", "approve", "reject", "confirm", "decline"];

export interface KycCase {
  id: number;
  kind: "screening_match" | "sanctions_hit" | "manual";
  risk: "standard" | "high";
  flags: string[];
  summary: string;
  status: string;
  twoOfficers: boolean;
  proposal: "approve" | "reject" | null;
  proposedBy: string | null;
  proposalReason: string | null;
  proposedAt: string | null;
  clearance: { id: number; proposal: string; status: string; requestedBy: string; expiresAt: string; decidedBy: string | null } | null;
  openedBy: string;
  openedAt: string;
  updatedAt: string;
  decidedBy: string | null;
  decisionReason: string | null;
  decidedAt: string | null;
  checkId: number | null;
  digest: string;
  subject: SubjectView;
  checks: { id: number; kind: string; outcome: string; reason: string; score: number | null; listVersion: string | null; provider: string; at: string }[];
  events: { action: string; from: string | null; to: string; actor: string; reason: string; at: string }[];
  otherCases: { id: number; kind: string; status: string }[];
  rescreens: { id: number; status: string; requestedBy: string; requestedAt: string; result: string | null }[];
  blockers: Record<CaseAction, string[]>;
}

export async function kycCase(sessionHash: Buffer, id: string): Promise<KycCase | null> {
  const { rows } = await db().query<{ v: KycCase | null }>("SELECT admin.kyc_case($1, $2) AS v", [sessionHash, id]);
  return rows[0]?.v ?? null;
}

export interface ScreeningRow {
  subjectId: string;
  subject: string;
  cnic: string;
  status: string;
  checkId: number;
  outcome: string;
  reason: string;
  score: number | null;
  listVersion: string | null;
  provider: string;
  at: string;
  case: number | null;
  rescreen: string | null;
}

export interface Screenings {
  listVersions: string[];
  rows: ScreeningRow[];
  queue: { id: number; subject: string; status: string; requestedBy: string; requestedAt: string; finishedAt: string | null; result: string | null; error: string | null }[];
}

export async function screenings(sessionHash: Buffer, outcome: string | null): Promise<Screenings> {
  const { rows } = await db().query<{ v: Screenings }>("SELECT admin.screenings($1, $2) AS v", [sessionHash, outcome]);
  const v = rows[0]?.v;
  if (!v) throw new Error("no screenings");
  return v;
}

export interface ReasonCode {
  code: string;
  appliesTo: string;
  label: string;
}

export interface CommandView {
  id: number;
  kind: string;
  status: string;
  attempts: number;
  txHash: string | null;
  lastError: string | null;
  createdAt: string;
}

export interface FreezeList {
  reasonCodes: ReasonCode[];
  policies: { freeze: boolean; unfreeze: boolean };
  holds: { id: number; wallet: string; subject: string; freezeRequest: number; placedAt: string }[];
  requests: {
    id: number;
    kind: "freeze" | "unfreeze";
    wallet: string;
    reasonCode: string;
    status: string;
    requestedBy: string;
    requestedAt: string;
    decidedBy: string | null;
    decidedAt: string | null;
    command: CommandView | null;
  }[];
}

export async function freezeList(sessionHash: Buffer): Promise<FreezeList> {
  const { rows } = await db().query<{ v: FreezeList }>("SELECT admin.freeze_requests($1) AS v", [sessionHash]);
  const v = rows[0]?.v;
  if (!v) throw new Error("no freeze list");
  return v;
}

export interface FreezeRequest {
  id: number;
  kind: "freeze" | "unfreeze";
  wallet: string;
  reasonCode: string;
  reasonLabel: string | null;
  reason: string;
  kycCase: number | null;
  strCase: number | null;
  lifts: number | null;
  caseId: string;
  requestedBy: string;
  requestedAt: string;
  expiresAt: string;
  status: string;
  decidedBy: string | null;
  decisionReason: string | null;
  decidedAt: string | null;
  commandKey: string | null;
  command: CommandView | null;
  subject: SubjectView;
  digest: string;
  blockers: string[];
  approveBlockers: string[];
}

export async function freezeRequest(sessionHash: Buffer, id: string): Promise<FreezeRequest | null> {
  const { rows } = await db().query<{ v: FreezeRequest | null }>("SELECT admin.freeze_request($1, $2) AS v", [sessionHash, id]);
  return rows[0]?.v ?? null;
}

export interface StrList {
  categories: { code: string; label: string }[];
  cases: { id: number; category: string; status: string; subject: string | null; openedBy: string; openedAt: string; updatedAt: string; notes: number; fmuReference: string | null; overdue: boolean }[];
}

export async function strList(sessionHash: Buffer): Promise<StrList> {
  const { rows } = await db().query<{ v: StrList }>("SELECT admin.str_cases($1) AS v", [sessionHash]);
  const v = rows[0]?.v;
  if (!v) throw new Error("no STR list");
  return v;
}

export type StrAction = "start_review" | "propose_close" | "confirm_close" | "decline_close" | "mark_filed";
export const STR_ACTIONS: readonly StrAction[] = ["start_review", "propose_close", "confirm_close", "decline_close", "mark_filed"];

export interface StrCase {
  id: number;
  category: string;
  categoryLabel: string | null;
  summary: string;
  status: string;
  openedBy: string;
  openedAt: string;
  updatedAt: string;
  closeProposedBy: string | null;
  closeProposedReason: string | null;
  closedBy: string | null;
  closedReason: string | null;
  filedBy: string | null;
  fmuReference: string | null;
  finishedAt: string | null;
  subject: SubjectView | null;
  digest: string;
  notes: { id: number; author: string; body: string; at: string }[];
  events: { action: string; from: string | null; to: string; actor: string; reason: string; at: string }[];
  exports: { id: number; by: string; sha256: string; at: string }[];
  blockers: Record<StrAction | "note" | "export", string[]>;
}

export async function strCase(sessionHash: Buffer, id: string): Promise<StrCase | null> {
  const { rows } = await db().query<{ v: StrCase | null }>("SELECT admin.str_case($1, $2) AS v", [sessionHash, id]);
  return rows[0]?.v ?? null;
}

export async function strExportData(sessionHash: Buffer, id: string): Promise<Record<string, unknown> | null> {
  const { rows } = await db().query<{ v: Record<string, unknown> | null }>("SELECT admin.str_export_data($1, $2) AS v", [sessionHash, id]);
  return rows[0]?.v ?? null;
}

const CASE_LABELS = new Map<string, string>([
  ["request_info", "Request more information"],
  ["info_received", "Information received"],
  ["escalate", "Escalate to high risk"],
  ["approve", "Approve"],
  ["reject", "Reject"],
  ["confirm", "Confirm the proposal (second officer)"],
  ["decline", "Decline the proposal (second officer)"],
  ["start_review", "Start the review"],
  ["propose_close", "Propose closing without a report"],
  ["confirm_close", "Confirm closing (second officer)"],
  ["decline_close", "Decline closing (second officer)"],
  ["mark_filed", "Record the FMU filing"],
]);

export function actionLabel(a: string): string {
  return CASE_LABELS.get(a) ?? a;
}

const KIND_LABELS = new Map<string, string>([
  ["screening_match", "Possible screening match"],
  ["sanctions_hit", "Confirmed sanctions hit"],
  ["manual", "Manual review"],
]);

export function caseKindLabel(k: string): string {
  return KIND_LABELS.get(k) ?? k;
}

/** Chip class for a state. */
export function stateChip(s: string): string {
  if (["approved", "filed", "verified", "done", "confirmed"].includes(s)) return "chip ok";
  if (["rejected", "revoked", "failed", "expired", "suspended", "closed"].includes(s)) return "chip bad";
  if (["superseded"].includes(s)) return "chip";
  return "chip warn";
}
