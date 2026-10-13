import { db } from "./db";

/** Shape of admin.ops_overview() (see the migration): counts and health only, no personal data. */
export interface OpsOverview {
  at: string;
  indexer: {
    deployment: string;
    chainId: number;
    block: number;
    updatedAt: string;
    batches: number;
    events: number;
    haltedAt: string | null;
    haltReason: string | null;
  }[];
  outbox: { status: string; commands: number; oldestSeconds: number }[];
  outboxRecent: {
    id: number;
    kind: string;
    status: string;
    attempts: number;
    maxAttempts: number;
    ageSeconds: number;
    txHash: string | null;
    lastError: string | null;
  }[];
  signer: { pendingApprovals: number };
  recon: {
    gate: {
      allowed: boolean;
      frozen: boolean;
      reason: string;
      lastRun: number | null;
      lastStatus: string | null;
      lastFinished: string | null;
    } | null;
    lastRun: {
      id: number;
      status: string;
      startedAt: string;
      finishedAt: string | null;
      pinnedBlock: number | null;
      blocking: number | null;
      warnings: number | null;
      error: string | null;
    } | null;
    lastFindings: { check: string; severity: string; count: number }[];
    openUnfreezeRequests: number;
  };
  anchor: {
    latest: {
      id: number;
      status: string;
      besuBlock: number;
      anchorChainId: number;
      anchorBlock: number | null;
      createdAt: string;
      confirmedAt: string | null;
      failure: string | null;
    } | null;
    confirmed: number;
    open: number;
    failed24h: number;
  };
  kyc: { subjects: number; byStatus: Record<string, number>; openClearances: number };
  bank: { batches: Record<string, number>; suspense: number; coolingOff: number };
  ledger: { journals: number; lastAt: string | null };
}

export async function opsOverview(sessionHash: Buffer): Promise<OpsOverview> {
  const { rows } = await db().query<{ v: OpsOverview }>("SELECT admin.ops_overview($1) AS v", [sessionHash]);
  const v = rows[0]?.v;
  if (!v) throw new Error("no overview");
  return v;
}
