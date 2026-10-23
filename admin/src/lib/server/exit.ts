import { db } from "./db";
import type { CommandView } from "./compliance";

/**
 * S-05 reads (migration 0027). Every function here is one call of an admin.* database function that
 * checks the session and exit.read itself; shapes mirror the jsonb those functions build. Amounts
 * are integer paisa and units integers, both as strings; documents are SHA-256 only; investors of a
 * redemption window appear as the first 8 hex digits of their KYC reference, never by name or CNIC.
 */

export interface ExitOverview {
  cases: {
    id: number;
    token: string;
    state: string;
    openedBy: string;
    openedAt: string;
    updatedAt: string;
    offerPaisa: string;
    salePricePaisa: string | null;
    recordDate: string | null;
    openDecision: { id: number; code: string; votes: number; needed: number } | null;
  }[];
  windows: {
    id: number;
    token: string;
    status: string;
    opensAt: string;
    closesAt: string;
    pricePerUnitPaisa: string;
    capUnits: string | null;
    outcome: string;
    open: boolean;
    requested: string;
    requests: number;
  }[];
  tokens: { token: string; supply: string; cap: string | null; paused: boolean | null; exitUnderway: boolean }[];
  burnPolicy: boolean;
  settings: Record<string, unknown> | null;
}

export async function exitOverview(sessionHash: Buffer): Promise<ExitOverview> {
  const { rows } = await db().query<{ v: ExitOverview }>("SELECT admin.exit_overview($1) AS v", [sessionHash]);
  const v = rows[0]?.v;
  if (!v) throw new Error("no exit overview");
  return v;
}

export interface ExitDecision {
  id: number;
  code: string;
  label: string;
  detail: Record<string, unknown>;
  reason: string;
  proposedBy: string;
  proposedAt: string;
  status: "open" | "approved" | "rejected";
  closedAt: string | null;
  capacities: string[];
  votes: { capacity: string; officer: string; vote: "approve" | "reject"; reason: string; at: string }[];
  myCapacities: string[];
  problem: string | null;
  digest: string;
}

export interface WaterfallLine {
  id: number;
  kind: string;
  rank: number;
  payee: string | null;
  description: string;
  amount: string;
  evidence: string;
  addedBy: string;
  withdrawn: boolean;
  journal: number | null;
  paid: string;
  payments: { id: number; reference: string | null; amount: string; status: string; proposedBy: string; decidedBy: string | null; digest: string }[];
}

export interface ExitCase {
  id: number;
  token: string;
  property: string | null;
  state: string;
  rationale: string;
  offerPaisa: string;
  valuationA: string;
  valuationASha: string;
  valuationB: string;
  valuationBSha: string;
  priceFloor: string;
  costsPaisa: string;
  voteRequired: boolean;
  openedBy: string;
  openedAt: string;
  updatedAt: string;
  facts: Record<string, string | boolean | number>;
  events: { code: string; from: string; to: string; actor: string; decision: number | null; at: string }[];
  decisions: ExitDecision[];
  possibleDecisions: { code: string; label: string; capacities: string[] }[];
  conflicts: { officer: string; note: string; at: string }[];
  proceeds: {
    id: number;
    kind: "deposit" | "proceeds";
    seq: number;
    reference: string;
    valueDate: string;
    amount: string;
    source: string;
    status: string;
    proposedBy: string;
    decidedBy: string | null;
    journal: number | null;
    note: string;
    digest: string;
  }[];
  proceedsApproved: string;
  pool: string;
  closureReserve: string;
  waterfall: {
    id: number;
    version: number;
    status: string;
    createdBy: string;
    submittedBy: string | null;
    checkedBy: string | null;
    approvedBy: string | null;
    returnedBy: string | null;
    returnReason: string | null;
    inflows: string | null;
    outflows: string | null;
    problem: string | null;
    digest: string;
    lines: WaterfallLine[];
  } | null;
  final: {
    id: number;
    status: string;
    recordDate: string;
    recordBlock: number;
    incomeType: string;
    proceeds: string;
    inflows: string;
    outflows: string;
    distributableGross: string;
    wht: string;
    net: string;
    holders: number;
    units: string;
    flagged: number;
    placeholder: number;
    root: string | null;
    statementHash: string | null;
    calculatedBy: string;
    attachedBy: string | null;
    decidedBy: string | null;
    returnedReason: string | null;
    precheck: { decision: string; root: string | null; officer: string; reason: string; at: string } | null;
    onchain: { registry: string; id: string; status: string | null } | null;
    digest: string;
  } | null;
  redemption: {
    id: number;
    status: string;
    burnRule: string;
    lines: number;
    units: string;
    createdBy: string;
    checkedBy: string | null;
    decidedBy: string | null;
    itemsDigest: string;
    digest: string;
    items: {
      wallet: string;
      units: string;
      refId: string;
      net: string;
      payment: string;
      released: boolean;
      command: CommandView | null;
      burned: { block: number; tx: string; registerUnits: string | null } | null;
      problem: string | null;
    }[];
  } | null;
  chain: { supply: string; cap: string | null; paused: boolean | null; cursor: number | null; issuance: string | null } | null;
  registerUnits: string;
  closeProblem: string | null;
  caseDigest: string;
  me: { handle: string; roles: string[]; conflicted: boolean };
}

export async function exitCase(sessionHash: Buffer, id: string): Promise<ExitCase | null> {
  const { rows } = await db().query<{ v: ExitCase | null }>("SELECT admin.exit_case($1, $2) AS v", [sessionHash, id]);
  return rows[0]?.v ?? null;
}

export interface ExitWindow {
  id: number;
  token: string;
  status: string;
  opensAt: string;
  closesAt: string;
  navPerUnitPaisa: string;
  navSha: string;
  discountPpm: number;
  pricePerUnitPaisa: string;
  capUnits: string | null;
  note: string;
  proposedBy: string;
  proposedAt: string;
  decidedBy: string | null;
  decisionReason: string | null;
  open: boolean;
  closed: boolean;
  outcome: { status: string; by: string | null; decidedBy: string | null; reason: string | null };
  requests: { id: string; subject: string; wallet: string; units: string; indicativePaisa: string; status: string; createdAt: string }[];
  digest: string;
}

export async function exitWindow(sessionHash: Buffer, id: string): Promise<ExitWindow | null> {
  const { rows } = await db().query<{ v: ExitWindow | null }>("SELECT admin.exit_window($1, $2) AS v", [sessionHash, id]);
  return rows[0]?.v ?? null;
}
