import type pg from "pg";
import type { Finding } from "./types.ts";

/**
 * Typed access to schema recon (migration 0006_recon.sql). The rules (append-only, status derived
 * from the findings, automatic freeze, maker-checker unfreeze, deny-by-default gate) live in the
 * database; this module only calls its functions.
 */

type Db = pg.ClientBase | pg.Pool;

export type RunStatus = "passed" | "failed" | "error";

export async function startRun(db: Db, actor: string, deployment: string, params: Record<string, unknown>): Promise<bigint> {
  const { rows } = await db.query<{ id: string }>("SELECT recon.start_run($1, $2, $3::jsonb) AS id", [actor, deployment, JSON.stringify(params)]);
  return BigInt(rows[0]?.id ?? "0");
}

/** Records the findings and finishes the run in one transaction; returns the status the database derived. */
export async function completeRun(db: Db, run: bigint, actor: string, pinnedBlock: bigint, findings: Finding[], summary: Record<string, unknown>): Promise<RunStatus> {
  const { rows } = await db.query<{ status: RunStatus }>(
    "SELECT recon.complete_run($1, $2, $3, $4::jsonb, $5::jsonb) AS status",
    [run.toString(), actor, pinnedBlock.toString(), JSON.stringify(findings), JSON.stringify(summary)],
  );
  const status = rows[0]?.status;
  if (!status) throw new Error("complete_run returned nothing");
  return status;
}

export async function failRun(db: Db, run: bigint, actor: string, error: string): Promise<void> {
  await db.query("SELECT recon.fail_run($1, $2, $3)", [run.toString(), actor, error.slice(0, 1000)]);
}

export interface Gate {
  allowed: boolean;
  frozen: boolean;
  reason: string;
  freezeEvent: bigint | null;
  lastRun: bigint | null;
  lastStatus: string | null;
  lastFinished: Date | null;
}

/** The payout gate (R-4): payouts only when not frozen and the latest run passed within 26 hours. */
export async function payoutGate(db: Db): Promise<Gate> {
  const { rows } = await db.query<{ allowed: boolean; frozen: boolean; reason: string; freeze_event: string | null; last_run: string | null; last_status: string | null; last_finished: Date | null }>(
    "SELECT * FROM recon.payout_gate()");
  const r = rows[0];
  if (!r) return { allowed: false, frozen: false, reason: "gate unavailable", freezeEvent: null, lastRun: null, lastStatus: null, lastFinished: null };
  return {
    allowed: r.allowed, frozen: r.frozen, reason: r.reason, freezeEvent: r.freeze_event === null ? null : BigInt(r.freeze_event),
    lastRun: r.last_run === null ? null : BigInt(r.last_run), lastStatus: r.last_status, lastFinished: r.last_finished,
  };
}

/** Maker: asks to unfreeze payouts (reason of at least 10 characters). */
export async function requestUnfreeze(db: Db, operator: string, reason: string): Promise<bigint> {
  const { rows } = await db.query<{ id: string }>("SELECT recon.request_unfreeze($1, $2) AS id", [operator, reason]);
  return BigInt(rows[0]?.id ?? "0");
}

/** Checker: a different operator approves or rejects. Returns the request's resulting status. */
export async function decideUnfreeze(db: Db, request: bigint, operator: string, decision: "approve" | "reject", reason: string): Promise<string> {
  const { rows } = await db.query<{ status: string }>("SELECT recon.decide_unfreeze($1, $2, $3, $4) AS status", [request.toString(), operator, decision, reason]);
  return rows[0]?.status ?? "unknown";
}

export async function registerBankAccount(db: Db, account: string, ledgerAccount: string, operator: string): Promise<boolean> {
  const { rows } = await db.query<{ ok: boolean }>("SELECT recon.register_bank_account($1, $2, $3) AS ok", [account, ledgerAccount, operator]);
  return rows[0]?.ok ?? false;
}
