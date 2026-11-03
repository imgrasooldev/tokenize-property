import { db } from "./db";
import type { SubjectView } from "./compliance";

/**
 * Transaction monitoring reads (migration 0051, compliance officers and auditors). Each function is
 * one call of an admin.* database function that checks the session and compliance.read itself.
 * Evidence holds references and amounts only: no name, CNIC, IBAN or phone number.
 */

export interface TmRule {
  code: string;
  label: string;
  strCategory: string;
  params: Record<string, number>;
  /** Allowed range of each parameter: [min, max]. */
  spec: Record<string, [number, number]>;
  enabled: boolean;
  placeholder: boolean;
  updatedBy: string;
  updatedAt: string;
}

export interface TmAlertRow {
  id: number;
  rule: string;
  ruleLabel: string;
  status: string;
  subject: string;
  windowFrom: string;
  windowTo: string;
  amountPaisa: string;
  summary: string;
  openedBy: string;
  openedAt: string;
  updatedAt: string;
  dismissProposedBy: string | null;
  dismissReason: string | null;
  dismissedBy: string | null;
  escalatedBy: string | null;
  strCase: number | null;
  overdue: boolean;
}

export interface TmDesk {
  rules: TmRule[];
  open: TmAlertRow[];
  closed: TmAlertRow[];
}

export interface TmEvidence {
  kind: string;
  ref: string;
  at?: string;
  amountPaisa?: string;
  last4?: string;
}

export interface TmAlert extends TmAlertRow {
  evidence: TmEvidence[];
  params: Record<string, number>;
  investor: SubjectView | null;
  declaredIncomePaisa: string | null;
  events: { action: string; from: string | null; to: string; actor: string; reason: string; at: string }[];
  digest: string;
  blockers: Record<TmAction, string[]>;
}

export type TmAction = "escalate" | "propose_dismiss" | "confirm_dismiss" | "decline_dismiss";
export const TM_ACTIONS: readonly TmAction[] = ["escalate", "propose_dismiss", "confirm_dismiss", "decline_dismiss"];

const TM_LABELS = new Map<string, string>([
  ["opened", "Opened by the rules"],
  ["escalate", "Open an STR case"],
  ["propose_dismiss", "Propose dismissing (no suspicion)"],
  ["confirm_dismiss", "Confirm dismissing (second officer)"],
  ["decline_dismiss", "Decline dismissing (second officer)"],
]);

export function tmActionLabel(a: string): string {
  return TM_LABELS.get(a) ?? a;
}

const PARAM_LABELS = new Map<string, string>([
  ["thresholdPaisa", "Threshold (paisa)"],
  ["bandPercent", "Counts from % of the threshold"],
  ["minCount", "Payments at least"],
  ["windowDays", "Window (days)"],
  ["outPercent", "Out again at least %"],
  ["minInPaisa", "Payment at least (paisa)"],
  ["lookbackDays", "Look back (days)"],
  ["percentOfIncome", "% of declared income"],
  ["maxAccounts", "Accounts allowed"],
]);

export function paramLabel(k: string): string {
  return PARAM_LABELS.get(k) ?? k;
}

export async function tmDesk(sessionHash: Buffer): Promise<TmDesk> {
  const { rows } = await db().query<{ v: TmDesk | null }>("SELECT admin.tm_desk($1) AS v", [sessionHash]);
  return rows[0]?.v ?? { rules: [], open: [], closed: [] };
}

export async function tmAlert(sessionHash: Buffer, id: string): Promise<TmAlert | null> {
  const { rows } = await db().query<{ v: TmAlert | null }>("SELECT admin.tm_alert($1, $2) AS v", [sessionHash, id]);
  return rows[0]?.v ?? null;
}
