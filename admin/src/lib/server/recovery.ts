import { db } from "./db";
import type { CommandView, SubjectView } from "./compliance";

/**
 * S-06 reads (migration 0020). Every function here is one call of an admin.* database function that
 * checks the session and recovery.read itself; shapes mirror the jsonb those functions build. No
 * name, CNIC (last four digits only, masked), IBAN or phone number is ever returned; documents are
 * metadata and SHA-256 only.
 */

export type CaseKind = "wallet_recovery" | "succession" | "reversal";
export type Capacity = "operations" | "compliance" | "legal";

export interface CaseList {
  at: string;
  policies: Record<"freeze" | "unfreeze" | "add_key" | "propose" | "execute" | "cancel", boolean>;
  reasons: { code: string; label: string }[];
  reversibleKinds: { kind: string; label: string }[];
  counts: Record<string, number>;
  cases: {
    id: number;
    kind: CaseKind;
    status: string;
    subject: string | null;
    wallet: string | null;
    newWallet: string | null;
    journal: number | null;
    openedBy: string;
    openedAt: string;
    updatedAt: string;
    approvals: number;
    needed: number;
    objectionUntil: string | null;
  }[];
}

export async function caseList(sessionHash: Buffer, kind: string | null, status: string | null): Promise<CaseList> {
  const { rows } = await db().query<{ v: CaseList }>("SELECT admin.recovery_cases($1, $2, $3) AS v", [sessionHash, kind, status]);
  const v = rows[0]?.v;
  if (!v) throw new Error("no case list");
  return v;
}

export interface RequestView {
  id: number;
  kind: "wallet_recovery" | "forced_transfer";
  from: string;
  to: string;
  amount: string;
  status: string;
  requestId: string | null;
  eta: string | null;
  propose: CommandView | null;
  execute: CommandView | null;
  cancel: CommandView | null;
}

export interface CaseDetail {
  id: number;
  kind: CaseKind;
  status: string;
  caseId: string;
  summary: string;
  openedBy: string;
  openedAt: string;
  updatedAt: string;
  objectionUntil: string | null;
  approvedAt: string | null;
  closedAt: string | null;
  subject: SubjectView | null;
  token: string | null;
  recoveryGuard: string | null;
  wallet: string | null;
  newWallet: string | null;
  identity: string | null;
  onChain: { balance: string; frozen: boolean; newWalletBalance: string | null; newWalletFrozen: boolean | null } | null;
  reverified: boolean | null;
  evidenceHash: string | null;
  unitsTotal: string | null;
  unitsResidual: string | null;
  journal: { id: number; kind: string; key: string; externalRef: string | null; memo: string | null; createdAt: string; postings: { account: string; amount: string }[] } | null;
  reasonCode: string | null;
  evidenceSha256: string | null;
  reversalJournal: number | null;
  cancelledBy: string | null;
  cancelReason: string | null;
  releaseProposedBy: string | null;
  releaseReason: string | null;
  releasedBy: string | null;
  unfreezeWallet: string | null;
  commands: { freeze: CommandView | null; addKey: CommandView | null; unfreeze: CommandView | null };
  documents: { id: number; type: string; reference: string; issuer: string | null; sha256: string; addedBy: string; addedAt: string }[];
  heirs: { id: number; subject: string; cnic: string; status: string; wallet: string; share: string; addedBy: string }[];
  allocationPreview: { heir: number; units: string }[] | null;
  approvals: { capacity: Capacity; officer: string; decision: "approve" | "reject"; reason: string; at: string }[];
  needed: Capacity[];
  requests: RequestView[];
  policies: CaseList["policies"];
  myCapacities: Capacity[];
  digest: string;
  blockers: { maker: string[]; decide: string[]; approve: string[]; cancel: string[]; release: string[] };
}

export async function caseDetail(sessionHash: Buffer, id: string): Promise<CaseDetail | null> {
  const { rows } = await db().query<{ v: CaseDetail | null }>("SELECT admin.recovery_case($1, $2) AS v", [sessionHash, id]);
  return rows[0]?.v ?? null;
}

const KIND = new Map<string, string>([
  ["wallet_recovery", "Lost / compromised wallet"],
  ["succession", "Succession (deceased investor)"],
  ["reversal", "Reversal of a platform error"],
]);
export function caseKindLabel(k: string): string {
  return KIND.get(k) ?? k;
}

const CAPACITY = new Map<string, string>([
  ["operations", "Operations checker"],
  ["compliance", "Compliance officer"],
  ["legal", "Legal officer"],
]);
export function capacityLabel(c: string): string {
  return CAPACITY.get(c) ?? c;
}

export const DOC_TYPES = [
  ["death_certificate", "Death certificate (NADRA)"],
  ["succession_certificate", "Succession certificate"],
  ["letters_of_administration", "Letters of administration"],
  ["court_order", "Court order"],
  ["family_settlement", "Family settlement (all adult heirs)"],
  ["reverification", "Re-verification record (branch / video call)"],
  ["other", "Other"],
] as const;
export const DOC_TYPE_CODES: readonly string[] = DOC_TYPES.map(([c]) => c);

export function docTypeLabel(t: string): string {
  return new Map<string, string>(DOC_TYPES.map(([c, l]) => [c, l])).get(t) ?? t;
}

/** Chip class for a case or request state. */
export function caseChip(s: string): string {
  if (["closed", "executed", "approved", "confirmed"].includes(s)) return "chip ok";
  if (["rejected", "cancelled", "failed", "review"].includes(s)) return "chip bad";
  return "chip warn";
}
