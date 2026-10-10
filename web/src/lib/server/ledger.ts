import type pg from "pg";

/**
 * Thin client for the PostgreSQL ledger (backend/packages/db/migrations/0002_ledger.sql). The rules
 * (balanced journals, no overdraft, idempotency, hash chain) are enforced inside the database, so
 * this file only shapes the calls. Same API as backend/packages/ledger, which the web prototype
 * cannot import because it is a separate npm project.
 */
type Db = pg.ClientBase | pg.Pool;

export type AccountKind = "asset" | "liability" | "equity" | "income" | "expense";

export interface Posting {
  account: string;
  /** Positive = debit, negative = credit. PKR in paisa. */
  amount: bigint;
}

export interface JournalInput {
  idempotencyKey: string;
  kind: string;
  memo?: string;
  externalRef?: string;
  createdBy: string;
  postings: Posting[];
}

export async function openAccount(db: Db, code: string, kind: AccountKind, asset: string): Promise<void> {
  await db.query("SELECT ledger.open_account($1, $2, $3, false)", [code, kind, asset]);
}

/** Posts a journal; an identical retry with the same idempotency key returns the same id. */
export async function postJournal(db: Db, j: JournalInput): Promise<bigint> {
  const postings = JSON.stringify(j.postings.map((p) => ({ account: p.account, amount: p.amount.toString() })));
  const { rows } = await db.query<{ id: string }>(
    "SELECT ledger.post_journal($1, $2, $3, $4, $5, $6::jsonb) AS id",
    [j.idempotencyKey, j.kind, j.memo ?? null, j.externalRef ?? null, j.createdBy, postings],
  );
  return BigInt(rows[0]?.id ?? "0");
}

export async function balanceOf(db: Db, code: string): Promise<bigint> {
  const { rows } = await db.query<{ balance: string }>("SELECT balance FROM ledger.balances WHERE code = $1", [code]);
  return BigInt(rows[0]?.balance ?? "0");
}

let chainCheck: { at: number; value: Promise<number> } | null = null;

/** chainProblems, re-run at most every 10 s: a full scan of the journal on every page load is wasteful. */
export async function chainProblemsCached(db: Db): Promise<number> {
  if (chainCheck && Date.now() - chainCheck.at < 10_000) return chainCheck.value;
  const value = chainProblems(db);
  chainCheck = { at: Date.now(), value };
  value.catch(() => (chainCheck = null));
  return value;
}

/** Number of journals that fail the hash-chain check (0 = intact). */
export async function chainProblems(db: Db): Promise<number> {
  const { rows } = await db.query<{ n: string }>("SELECT count(*) AS n FROM ledger.verify_chain()");
  return Number(rows[0]?.n ?? "0");
}
