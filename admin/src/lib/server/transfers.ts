import { db } from "./db";
import type { CommandView, SubjectView } from "./compliance";

/**
 * S-04 phase 0 reads (migration 0028, spec section 16). Every function here is one call of an
 * admin.* database function that checks the session and transfer.read itself; shapes mirror the
 * jsonb those functions build. Parties are masked (admin.subject_json: reference, CNIC last digits
 * only); amounts are integer paisa as strings; surveillance alerts come back only for holders of
 * compliance.read (tipping-off), as NULL for everyone else.
 */

export type Consideration = "sale" | "gift" | "family" | "court_order";
export type Capacity = "compliance" | "trustee";
export type Policies = Record<"propose" | "execute" | "cancel", boolean>;

export const STATES = [
  "requested",
  "checks",
  "rejected",
  "awaiting_cash",
  "proposed",
  "cancelling",
  "failed",
  "refunding",
  "executed",
  "settled",
  "disputed",
  "cancelled",
] as const;

export interface TransferList {
  at: string;
  policies: Policies;
  token: string | null;
  referencePrice: { pricePaisa: string; source: string } | null;
  settings: Record<string, unknown> | null;
  counts: Record<string, number>;
  openBlocks: { id: number; token: string; source: "exit" | "incident"; ref: string; reason: string; openedAt: string }[];
  prices: { id: number; token: string; pricePaisa: string; evidence: string; reason: string; by: string; at: string }[];
  cases: {
    id: number;
    status: string;
    origin: "desk" | "investor";
    consideration: Consideration;
    units: string;
    totalPaisa: string | null;
    seller: string;
    buyer: string;
    accepted: boolean;
    openedBy: string;
    openedAt: string;
    updatedAt: string;
    approvals: number;
    eta: string | null;
  }[];
}

export async function transferList(sessionHash: Buffer, status: string | null): Promise<TransferList> {
  const { rows } = await db().query<{ v: TransferList }>("SELECT admin.transfer_cases($1, $2) AS v", [sessionHash, status]);
  const v = rows[0]?.v;
  if (!v) throw new Error("no transfer list");
  return v;
}

export interface Check {
  code: string;
  ok: boolean;
  detail: string;
}

export interface CashOp {
  id: number;
  kind: "settlement" | "refund";
  attempt: number;
  reference: string;
  status: "prepared" | "approved" | "rejected";
  grossPaisa: string;
  feePaisa: string | null;
  taxPaisa: string | null;
  taxStatus: string | null;
  taxPlaceholder: boolean | null;
  netPaisa: string;
  payee: { bank: string; last4: string } | null;
  raastRef: string | null;
  preparedBy: string;
  preparedAt: string;
  decidedBy: string | null;
  decisionReason: string | null;
  decidedAt: string | null;
  fileSha256: string | null;
}

export interface TransferDetail {
  id: number;
  uuid: string;
  caseId: string;
  status: string;
  publicStatus: string;
  origin: "desk" | "investor";
  token: string;
  recoveryGuard: string;
  seller: SubjectView | null;
  sellerWallet: string;
  buyer: SubjectView | null;
  buyerWallet: string;
  units: string;
  consideration: Consideration;
  pricePaisa: string | null;
  totalPaisa: string | null;
  noPriceReason: string | null;
  agreementSha256: string;
  priceExplanation: string | null;
  holdingReason: string | null;
  openedBy: string;
  openedAt: string;
  acceptedAt: string | null;
  completedBy: string | null;
  completedAt: string | null;
  approvedAt: string | null;
  updatedAt: string;
  evidenceHash: string | null;
  payment: { code: string; payUntil: string | null; paidRef: string | null; paidAt: string | null; escrowPaisa: string } | null;
  request: { requestId: string | null; eta: string | null; executeAttempts: number; cancelAttempts: number; executedTx: string | null; executedAt: string | null };
  commands: { propose: CommandView | null; execute: CommandView | null; cancel: CommandView | null };
  cancelledBy: string | null;
  cancelReason: string | null;
  disputedBy: string | null;
  disputeReason: string | null;
  checks: { stage: string; passed: boolean; results: Check[]; at: string } | null;
  liveChecks: Check[] | null;
  decisions: { capacity: Capacity; officer: string; decision: "approve" | "reject"; reason: string; at: string }[];
  events: { from: string | null; to: string; actor: string; reason: string; at: string }[];
  cash: CashOp[];
  /** Compliance officers and auditors only (NULL for every other role: tipping-off). */
  alerts: { rule: string; detail: string; strCase: number; at: string }[] | null;
  policies: Policies;
  myCapacities: Capacity[];
  digest: string;
  blockers: { maker: string[]; decide: string[]; cancel: string[]; dispute: string[]; prepare: string[]; confirm: string[] };
}

export async function transferDetail(sessionHash: Buffer, id: string): Promise<TransferDetail | null> {
  const { rows } = await db().query<{ v: TransferDetail | null }>("SELECT admin.transfer_case($1, $2) AS v", [sessionHash, id]);
  return rows[0]?.v ?? null;
}

export interface TransferAudit {
  problems: number;
  firstProblem: string | null;
  rows: { id: number; at: string; actor: string; action: string; detail: Record<string, unknown>; hash: string }[];
}

export async function transferAudit(sessionHash: Buffer, before: string | null, limit: number): Promise<TransferAudit> {
  const { rows } = await db().query<{ v: TransferAudit }>("SELECT admin.transfer_audit($1, $2, $3) AS v", [sessionHash, before, limit]);
  const v = rows[0]?.v;
  if (!v) throw new Error("no transfer audit");
  return v;
}

const CONSIDERATION = new Map<string, string>([
  ["sale", "Sale"],
  ["gift", "Gift"],
  ["family", "Family transfer"],
  ["court_order", "Court order"],
]);
export function considerationLabel(c: string): string {
  return CONSIDERATION.get(c) ?? c;
}

const CAPACITY = new Map<string, string>([
  ["compliance", "Compliance officer"],
  ["trustee", "Trustee officer"],
]);
export function capacityLabel(c: string): string {
  return CAPACITY.get(c) ?? c;
}

export const RELATIONS = [
  ["family", "Family"],
  ["related_company", "Related company"],
  ["common_control", "Common control"],
  ["other", "Other"],
] as const;

const CHECKS = new Map<string, string>([
  ["seller_kyc", "Seller KYC"],
  ["buyer_kyc", "Buyer KYC"],
  ["seller_screened", "Seller sanctions screening"],
  ["buyer_screened", "Buyer sanctions screening"],
  ["seller_case", "Seller: no open review or recovery"],
  ["buyer_case", "Buyer: no open review or recovery"],
  ["wallets", "Wallets bound and registered"],
  ["country", "Registry countries"],
  ["seller_frozen", "Seller wallet not frozen"],
  ["seller_balance", "Seller free balance"],
  ["register", "Trustee register"],
  ["buyer_headroom", "Buyer maximum holding"],
  ["lockup", "Lock-up"],
  ["exit", "No exit or incident block"],
  ["paused", "Token paused (phase 0)"],
  ["price_band", "Price band"],
  ["min_holding", "Seller minimum holding"],
  ["escrow", "Escrow (DvP)"],
  ["policy", "Signing policies"],
]);
export function checkLabel(code: string): string {
  return CHECKS.get(code) ?? code;
}

/** Chip class for a case or command state. */
export function transferChip(s: string): string {
  if (["executed", "settled", "approved", "confirmed"].includes(s)) return "chip ok";
  if (["rejected", "cancelled", "failed", "disputed", "review"].includes(s)) return "chip bad";
  return "chip warn";
}
