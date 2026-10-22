import type pg from "pg";

type Db = pg.Pool | pg.ClientBase;

/**
 * Recovery cases (spec S-06 section 14, migration 0020). Every rule lives in the database; this
 * module only calls it. recovery.tick links confirmed propose commands to their RecoveryProposed
 * events, enqueues execute once a request's delay passed, cancels pending requests of cancelled
 * cases, follows executions and moves the KYC binding after an executed wallet recovery.
 */
export async function tick(db: Db, actor: string): Promise<number> {
  const { rows } = await db.query<{ n: number }>("SELECT recovery.tick($1) AS n", [actor]);
  return rows[0]?.n ?? 0;
}

/** Problems in the recovery audit chain (empty = intact). */
export async function verifyAudit(db: Db): Promise<{ auditId: string | null; problem: string }[]> {
  const { rows } = await db.query<{ audit_id: string | null; problem: string }>("SELECT audit_id::text, problem FROM recovery.verify_audit()");
  return rows.map((r) => ({ auditId: r.audit_id, problem: r.problem }));
}
