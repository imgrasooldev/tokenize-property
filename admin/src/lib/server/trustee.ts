import type { Gate } from "./approvals";
import { db } from "./db";

/**
 * Step 6d reads (migration 0023). Every function is one call of an admin.* database function that
 * checks the session and trustee.read itself. Chain numbers come from the indexer's read model and
 * are pinned to its cursor block (one database snapshot per call). No personal data: wallets,
 * amounts, statuses and digests only.
 */

export interface Pinned {
  deployment: string;
  block: number;
  hash: string | null;
  updatedAt: string;
  halted: boolean;
  haltReason: string | null;
}

export interface TokenSummary {
  token: string;
  deployment: string;
  supply: string;
  cap: string;
  paused: boolean;
  registerTotal: string;
  differences: number;
  pinned: Pinned | null;
}

export interface TrusteeDashboard {
  at: string;
  tokens: TokenSummary[];
  cosignSigner: number;
  cosignOffering: number;
  /** S-03 (0021): charges above the operations limit and calculations waiting for the trustee. */
  cosignCharges: number;
  prechecks: number;
  distributionsInWindow: number;
  rejectedNotOnChain: number;
  openAdjustments: number;
  pendingRecoveries: number;
  gate: Gate;
  latestRun: { id: number; status: string; blocking: number | null; warnings: number | null; pinnedBlock: number | null; finishedAt: string | null } | null;
}

async function one<T>(sql: string, params: unknown[]): Promise<T | null> {
  const { rows } = await db().query<{ v: T | null }>(sql, params);
  return rows[0]?.v ?? null;
}

export async function trusteeDashboard(sessionHash: Buffer): Promise<TrusteeDashboard> {
  const v = await one<TrusteeDashboard>("SELECT admin.trustee_dashboard($1) AS v", [sessionHash]);
  if (!v) throw new Error("no dashboard");
  return v;
}

export interface RegisterLine {
  wallet: string;
  register: string;
  chain: string;
  difference: string;
}

export interface RegisterView {
  token: string;
  deployment: string;
  supply: string;
  cap: string;
  paused: boolean;
  tokenUpdatedBlock: number;
  pinned: Pinned | null;
  at: string;
  registerTotal: string;
  chainHolders: number;
  differences: number;
  attestation: { offering: string; totalUnits: number; registerSha: string; at: string } | null;
  lines: RegisterLine[];
  lineCount: number;
  adjustments: { id: number; wallet: string; units: string; status: string; proposedBy: string; proposedAt: string; decidedBy: string | null }[];
}

export const ADDRESS = /^0x[0-9a-f]{40}$/;

export async function registerView(sessionHash: Buffer, token: string, limit: number): Promise<RegisterView | null> {
  return one<RegisterView>("SELECT admin.trustee_register($1, $2, $3) AS v", [sessionHash, token, limit]);
}

export interface Adjustment {
  id: number;
  token: string;
  wallet: string;
  units: string;
  evidenceSha256: string;
  reason: string;
  proposedBy: string;
  proposedAt: string;
  expiresAt: string;
  status: string;
  decidedBy: string | null;
  decisionReason: string | null;
  decidedAt: string | null;
  entryId: number | null;
  registerBalance: string;
  chainBalance: string;
  pinned: Pinned | null;
  digest: string;
  blockers: string[];
  approveBlockers: string[];
}

export async function adjustment(sessionHash: Buffer, id: string): Promise<Adjustment | null> {
  return one<Adjustment>("SELECT admin.register_adjustment($1, $2) AS v", [sessionHash, id]);
}

export interface CosignQueue {
  at: string;
  signer: {
    id: string;
    kind: string;
    amount: string | null;
    requestedBy: string;
    createdAt: string;
    expiresAt: string;
    expired: boolean;
    approvalsNeeded: number;
    platformApprovals: number;
    trusteeApprovals: number;
    to: string | null;
    mine: boolean;
  }[];
  offering: { id: number; code: string; offering: string; offeringState: string; requestedBy: string; requestedAt: string; expiresAt: string | null; note: string; token: string | null }[];
  charges: { id: number; token: string; period: string; kind: string; payee: string | null; amount: string; proposedBy: string; proposedAt: string }[];
  calculations: { id: number; token: string; period: string; net: string; holders: number; calculatedBy: string; attachedAt: string | null }[];
  recent: { id: number; action: string; actor: string; at: string; ref: string | null; decision: string | null; result: string | null }[];
}

export async function cosignQueue(sessionHash: Buffer): Promise<CosignQueue> {
  const v = await one<CosignQueue>("SELECT admin.trustee_cosign_queue($1) AS v", [sessionHash]);
  if (!v) throw new Error("no queue");
  return v;
}

export interface TrusteeSignerRequest {
  id: string;
  commandRef: string;
  kind: string;
  keyRef: string;
  keyAddress: string | null;
  payload: Record<string, unknown>;
  payloadHash: string;
  amount: string | null;
  requestedBy: string;
  status: string;
  approvalsNeeded: number;
  trusteeApprovalsNeeded: number;
  platformApprovals: number;
  trusteeApprovals: number;
  reason: string | null;
  createdAt: string;
  expiresAt: string;
  policy: { id: number; version: number; proposedBy: string; approvedBy: string | null; active: boolean } | null;
  approvals: { operator: string; decision: string; reason: string | null; at: string; capacity: "platform" | "trustee" }[];
  command: { id: number; status: string; createdBy: string; ref: string | null; attempts: number; lastError: string | null; createdAt: string } | null;
  blockers: string[];
}

export async function trusteeSignerRequest(sessionHash: Buffer, id: string): Promise<TrusteeSignerRequest | null> {
  return one<TrusteeSignerRequest>("SELECT admin.trustee_signer_request($1, $2) AS v", [sessionHash, id]);
}

export interface OfferingRequest {
  id: number;
  code: string;
  note: string;
  needs: string[];
  status: string;
  offeringState: string;
  requestedBy: string;
  reason: string;
  detail: Record<string, unknown>;
  requestedAt: string;
  expiresAt: string | null;
  decidedAt: string | null;
  offering: {
    id: string;
    state: string;
    token: string | null;
    priceRupees: string | null;
    minRaiseUnits: number | null;
    targetUnits: number | null;
    hardCapUnits: number | null;
    trusteeCap: string | null;
    supply: string | null;
  };
  batch: {
    id: number;
    digest: string;
    items: number;
    totalUnits: number;
    preparedBy: string;
    preparedAt: string;
    matchesAllocations: boolean;
    lines: { line: number; refId: string; wallet: string; units: number }[];
  } | null;
  votes: { officer: string; duty: string; approve: boolean; reason: string; at: string }[];
  problem: string | null;
  digest: string;
  blockers: string[];
  approveBlockers: string[];
}

export async function offeringRequest(sessionHash: Buffer, id: string): Promise<OfferingRequest | null> {
  return one<OfferingRequest>("SELECT admin.trustee_offering_request($1, $2) AS v", [sessionHash, id]);
}

export interface TrusteeDecisionView {
  decision: "approve" | "reject";
  by: string;
  at: string;
  reason: string;
  recomputedRoot?: string | null;
}

export interface TrusteeCharge {
  id: number;
  token: string;
  period: string;
  kind: string;
  feeType: string | null;
  payee: string | null;
  description: string;
  amount: string;
  limit: string;
  evidence: string;
  status: string;
  proposedBy: string;
  proposedAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
  trustee: TrusteeDecisionView | null;
  digest: string;
  blockers: string[];
}

export async function trusteeCharge(sessionHash: Buffer, id: string): Promise<TrusteeCharge | null> {
  return one<TrusteeCharge>("SELECT admin.trustee_charge($1, $2) AS v", [sessionHash, id]);
}

export interface TrusteeCalculation {
  id: number;
  token: string;
  period: string;
  recordDate: string;
  recordBlock: number;
  incomeType: string;
  collected: string;
  expenses: string;
  fees: string;
  gross: string;
  wht: string;
  net: string;
  holders: number;
  units: string;
  status: string;
  root: string | null;
  statementHash: string | null;
  taxScheduleHash: string | null;
  calculatedBy: string;
  attachedBy: string | null;
  decidedBy: string | null;
  trustee: TrusteeDecisionView | null;
  lines: { wallet: string; units: string; gross: string; wht: string; net: string }[];
  digest: string;
  blockers: string[];
}

export async function trusteeCalculation(sessionHash: Buffer, id: string): Promise<TrusteeCalculation | null> {
  return one<TrusteeCalculation>("SELECT admin.trustee_calculation($1, $2) AS v", [sessionHash, id]);
}

export interface DistributionRow {
  registry: string;
  id: string;
  token: string;
  status: string;
  recordBlock: number;
  totalPaisa: string;
  publishedBlock: number;
  windowCloses: string | null;
  windowOpen: boolean;
  review: { decision: string; by: string; at: string } | null;
}

export async function distributions(sessionHash: Buffer): Promise<DistributionRow[]> {
  return (await one<DistributionRow[]>("SELECT admin.trustee_distributions($1) AS v", [sessionHash])) ?? [];
}

export interface Distribution {
  registry: string;
  id: string;
  token: string;
  status: string;
  recordBlock: number;
  merkleRoot: string;
  totalPaisa: string;
  statementHash: string;
  rejectReason: string | null;
  payoutBatchHash: string | null;
  publishedBlock: number;
  publishedAt: string | null;
  windowCloses: string | null;
  pinned: Pinned | null;
  ledgerBooked: boolean;
  payoutBatches: { id: number; reference: string; status: string; kind: string }[];
  review: { decision: string; reason: string; by: string; at: string; recomputedRoot: string | null; digest: string } | null;
  blocked: string | null;
  digest: string;
  blockers: string[];
}

export async function distribution(sessionHash: Buffer, registry: string, id: string): Promise<Distribution | null> {
  return one<Distribution>("SELECT admin.trustee_distribution($1, $2, $3) AS v", [sessionHash, registry, id]);
}

export interface ReconView {
  gate: Gate;
  days: { day: string; runs: number; passed: number; failed: number; error: number; blocking: number; warnings: number; last: number }[];
  runs: { id: number; status: string; startedAt: string; finishedAt: string | null; startedBy: string; pinnedBlock: number | null; blocking: number | null; warnings: number | null }[];
}

export async function reconView(sessionHash: Buffer, days: number): Promise<ReconView> {
  const v = await one<ReconView>("SELECT admin.trustee_recon($1, $2) AS v", [sessionHash, days]);
  if (!v) throw new Error("no reconciliation view");
  return v;
}

export interface ReconRun {
  id: number;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  startedBy: string;
  deployment: string | null;
  pinnedBlock: number | null;
  blocking: number | null;
  warnings: number | null;
  summary: Record<string, unknown> | null;
  error: string | null;
  digest: string | null;
  findings: { id: number; check: string; severity: "blocking" | "warning"; subject: string; expected: string | null; actual: string | null }[];
  findingCount: number;
}

export async function reconRun(sessionHash: Buffer, id: string): Promise<ReconRun | null> {
  return one<ReconRun>("SELECT admin.trustee_recon_run($1, $2) AS v", [sessionHash, id]);
}

export interface Recoveries {
  onChain: {
    guard: string;
    id: string;
    kind: "wallet_recovery" | "forced_transfer";
    from: string;
    to: string;
    amount: string;
    evidenceHash: string;
    status: string;
    eta: string;
    executable: boolean;
    cancelledBy: string | null;
    proposedBlock: number;
  }[];
  /** The S-06 hook (trustee.recovery_cases_json()): null until S-06 is merged, then its case list. */
  cases: Record<string, unknown>[] | null;
}

export async function recoveries(sessionHash: Buffer): Promise<Recoveries> {
  const v = await one<Recoveries>("SELECT admin.trustee_recoveries($1) AS v", [sessionHash]);
  if (!v) throw new Error("no recoveries view");
  return v;
}

/** Labels for the S-02 request codes the trustee votes on. */
const CODES = new Map<string, string>([
  ["L3", "Approve the offering"],
  ["L7", "Resume a suspended offering"],
  ["L8", "Cancel a suspended offering"],
  ["L10", "Extend the offering"],
  ["L11", "Confirm: offering funded"],
  ["L12", "Confirm: offering failed (min raise not met)"],
  ["L13", "Start completion (conditions precedent)"],
  ["L14", "Confirm the register entries (completed)"],
  ["L15", "Confirm: completion deadline missed"],
  ["L16", "Abort completion"],
  ["IB", "Issuance batch"],
  ["CMP", "Completion record and completion payment batch"],
  ["SD", "Supplementary disclosure"],
]);

export function codeLabel(code: string): string {
  return CODES.get(code) ?? code;
}

/** Units with en-PK grouping from a decimal string (arbitrary size, may be negative). */
export function units(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return "–";
  const s = String(v);
  if (!/^-?\d+$/.test(s)) return "–";
  const neg = s.startsWith("-");
  const digits = neg ? s.slice(1) : s;
  const groups: string[] = [];
  for (let end = digits.length; end > 0; end -= 3) groups.unshift(digits.slice(Math.max(0, end - 3), end));
  return `${neg ? "-" : ""}${groups.join(",")}`;
}
