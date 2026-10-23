import type pg from "pg";

type Db = pg.Pool | pg.ClientBase;

/**
 * Secondary transfers, phase 0 (spec S-04 section 16, migration 0028). Every rule lives in the
 * database; this module only calls it. transfer.tick books payments seen by the bank into their
 * cases (and cancels codes past their deadline), enqueues the on-chain proposal once the money is in
 * escrow, links confirmed proposals to their RecoveryProposed events, re-runs the checks after the
 * 48-hour delay and enqueues execute or cancel, follows executions (exact movement in the read model)
 * and writes the trustee register entries.
 */
export async function tick(db: Db, actor: string): Promise<number> {
  const { rows } = await db.query<{ n: number }>("SELECT transfer.tick($1) AS n", [actor]);
  return rows[0]?.n ?? 0;
}

/** Problems in the transfer audit chain (empty = intact). */
export async function verifyAudit(db: Db): Promise<{ auditId: string | null; problem: string }[]> {
  const { rows } = await db.query<{ audit_id: string | null; problem: string }>("SELECT audit_id::text, problem FROM transfer.verify_audit()");
  return rows.map((r) => ({ auditId: r.audit_id, problem: r.problem }));
}

/** One finding of transfer.reconcile(token) (spec 16.8). */
export interface TransferFinding {
  check: string;
  subject: string;
  expected: string;
  actual: string;
}

export async function reconcile(db: Db, token: string): Promise<TransferFinding[]> {
  const { rows } = await db.query<{ check_name: string; subject: string; expected: string; actual: string }>(
    "SELECT check_name, subject, expected, actual FROM transfer.reconcile($1)",
    [token.toLowerCase()],
  );
  return rows.map((r) => ({ check: r.check_name, subject: r.subject, expected: r.expected, actual: r.actual }));
}
