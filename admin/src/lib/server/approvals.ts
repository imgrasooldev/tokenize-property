import { db } from "./db";

/**
 * Step 6b reads and decisions. Every function here is one call of an admin.* database function
 * (migration 0016) that checks the session and permission itself; decisions also check a step-up
 * younger than five minutes and run the backend's own decision function under the officer's name.
 * Shapes mirror the jsonb those functions build; no personal data is returned by any of them.
 */

export interface Gate {
  allowed: boolean;
  frozen: boolean;
  reason: string;
  freezeEvent: number | null;
  lastRun: number | null;
  lastStatus: string | null;
  lastFinished: string | null;
}

export interface InboxSigner {
  id: string;
  kind: string;
  amount: string | null;
  requestedBy: string;
  createdAt: string;
  expiresAt: string;
  expired: boolean;
  approvalsNeeded: number;
  approvals: number;
  mine: boolean;
  to: string | null;
  from: string | null;
  distributionId: string | null;
}

export interface InboxPayout {
  id: number;
  reference: string;
  kind: string;
  token: string;
  distributionId: string;
  status: string;
  totalPaisa: string;
  paidPaisa: string;
  items: number;
  held: number;
  createdBy: string;
  createdAt: string;
  decidedBy: string | null;
}

export interface InboxUnfreeze {
  id: number;
  freezeEvent: number;
  requestedBy: string;
  reason: string;
  requestedAt: string;
  expiresAt: string;
  expired: boolean;
}

export interface InboxProperty {
  id: number;
  entity: "sponsor" | "property";
  entityId: string;
  code: string;
  fromState: string;
  toState: string | null;
  requestedBy: string;
  requestedAt: string;
  expiresAt: string;
  expired: boolean;
}

export interface Inbox {
  at: string;
  gate: Gate | null;
  signer: InboxSigner[] | null;
  payouts: InboxPayout[] | null;
  unfreeze: InboxUnfreeze[] | null;
  property: InboxProperty[] | null;
}

export async function inbox(sessionHash: Buffer): Promise<Inbox> {
  const { rows } = await db().query<{ v: Inbox }>("SELECT admin.approvals_inbox($1) AS v", [sessionHash]);
  const v = rows[0]?.v;
  if (!v) throw new Error("no inbox");
  return v;
}

export interface SignerRequest {
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
  reason: string | null;
  createdAt: string;
  expiresAt: string;
  policy: { id: number; version: number; proposedBy: string; approvedBy: string | null; active: boolean } | null;
  approvals: { operator: string; decision: string; reason: string | null; at: string }[];
  command: { id: number; status: string; createdBy: string; ref: string | null; attempts: number; lastError: string | null; createdAt: string } | null;
  gate: Gate | null;
  blockers: string[];
}

export async function signerRequest(sessionHash: Buffer, id: string): Promise<SignerRequest | null> {
  const { rows } = await db().query<{ v: SignerRequest | null }>("SELECT admin.signer_request($1, $2) AS v", [sessionHash, id]);
  return rows[0]?.v ?? null;
}

export interface PayoutLine {
  line: number;
  subject: string;
  bank: string | null;
  ibanLast4: string | null;
  amountPaisa: string;
  held: boolean;
  heldReason: string | null;
  returned: boolean;
}

export interface PayoutBatch {
  id: number;
  reference: string;
  kind: string;
  parentId: number | null;
  token: string;
  distributionId: string;
  status: string;
  totalPaisa: string;
  paidPaisa: string;
  heldPaisa: string;
  items: number;
  itemsDigest: string;
  itemsDigestVersion: number;
  fileSha256: string | null;
  journalId: number | null;
  createdBy: string;
  createdAt: string;
  decidedBy: string | null;
  decisionReason: string | null;
  decidedAt: string | null;
  submittedBy: string | null;
  submittedAt: string | null;
  lines: PayoutLine[];
  problems: string | null;
  gate: Gate;
  blockers: string[];
  approveBlockers: string[];
}

export async function payoutBatch(sessionHash: Buffer, id: string): Promise<PayoutBatch | null> {
  const { rows } = await db().query<{ v: PayoutBatch | null }>("SELECT admin.payout_batch($1, $2) AS v", [sessionHash, id]);
  return rows[0]?.v ?? null;
}

export interface UnfreezeRequest {
  id: number;
  status: string;
  requestedBy: string;
  reason: string;
  requestedAt: string;
  expiresAt: string;
  decidedBy: string | null;
  decisionReason: string | null;
  decidedAt: string | null;
  freeze: { event: number; at: string; run: number; reason: string; actor: string };
  freezingRun: { id: number; status: string; blocking: number | null; warnings: number | null; finishedAt: string | null } | null;
  latestRun: { id: number; status: string; blocking: number | null; warnings: number | null; finishedAt: string | null } | null;
  gate: Gate;
  blockers: string[];
  approveBlockers: string[];
}

export async function unfreezeRequest(sessionHash: Buffer, id: string): Promise<UnfreezeRequest | null> {
  const { rows } = await db().query<{ v: UnfreezeRequest | null }>("SELECT admin.unfreeze_request($1, $2) AS v", [sessionHash, id]);
  return rows[0]?.v ?? null;
}

export interface PropertyRequest {
  id: number;
  entity: "sponsor" | "property";
  entityId: string;
  code: string;
  fromState: string;
  transition: { toState: string; action: string } | null;
  requestedBy: string;
  reason: string;
  detail: Record<string, unknown>;
  requestedAt: string;
  expiresAt: string;
  status: string;
  decidedBy: string | null;
  decisionReason: string | null;
  decidedAt: string | null;
  digest: string;
  sponsor: { kind: string; state: string; cuinLast4: string | null; ntnLast4: string | null; kybValidUntil: string | null; risk: string | null } | null;
  property: { state: string; province: string | null; district: string | null; propertyKey: string | null; use: string | null; submittedAt: string | null } | null;
  checkerDuties: string[];
  blockers: string[];
}

export async function propertyRequest(sessionHash: Buffer, id: string): Promise<PropertyRequest | null> {
  const { rows } = await db().query<{ v: PropertyRequest | null }>("SELECT admin.property_request($1, $2) AS v", [sessionHash, id]);
  return rows[0]?.v ?? null;
}

/** Outcome of a decision function: refusals by the backend come back audited, not thrown. */
export interface DecisionResult {
  ok: boolean;
  status?: string;
  error?: string;
  id?: number;
  expiresAt?: string;
}

export async function decision(sql: string, params: unknown[]): Promise<DecisionResult> {
  const { rows } = await db().query<{ r: DecisionResult }>(sql, params);
  return rows[0]?.r ?? { ok: false, error: "no answer" };
}

/** Labels for S-01 transition codes (spec S-01 section 3). */
export const TRANSITIONS: Readonly<Record<string, string>> = {
  K4: "Approve KYB",
  K5: "Reject KYB",
  K10: "Reinstate suspended sponsor",
  K11: "Reject suspended sponsor",
  SC: "Clear a possible screening match",
  P6: "Reject property after a failed review",
  P13: "Resume property from hold",
  P14: "Reject property on hold",
};

export function transitionLabel(code: string): string {
  return new Map(Object.entries(TRANSITIONS)).get(code) ?? code;
}

/** "Mint 20,000 tokens", "Freeze wallet", ... for a signing request. */
export function kindLabel(kind: string, amount: string | null): string {
  const n = amount ? Number(amount).toLocaleString("en-PK") : null;
  switch (kind) {
    case "issuance.mint":
      return `Mint ${n ?? "?"} tokens`;
    case "token.transfer":
      return `Transfer ${n ?? "?"} tokens`;
    case "compliance.freeze":
      return "Freeze a wallet";
    case "rent.record_payout":
      return "Record a rent payout on chain";
    case "identity.create":
      return "Create an investor identity";
    case "identity.add_claim":
      return "Add a KYC claim";
    case "identity.register":
      return "Register an investor";
    default:
      return kind;
  }
}

/** Rupees from paisa, en-PK grouping: "Rs 1,000.00". */
export function rupees(paisa: string | null | undefined): string {
  if (!paisa || !/^-?\d+$/.test(paisa)) return "–";
  const v = BigInt(paisa);
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const whole = (abs / 100n).toLocaleString("en-PK");
  const cents = (abs % 100n).toString().padStart(2, "0");
  return `${neg ? "-" : ""}Rs ${whole}.${cents}`;
}
