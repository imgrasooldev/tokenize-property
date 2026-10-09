import type pg from "pg";
import { z } from "zod";

/**
 * Typed access to the ledger. All rules (balance, append-only, hash chain, idempotency, no
 * overdraft) are enforced inside PostgreSQL (migration 0002_ledger.sql); this module validates
 * early and gives friendly types, but never relies on itself for safety.
 *
 * Amounts are bigint: PKR in paisa, tokens in units. Positive = debit, negative = credit.
 */

export type AccountKind = "asset" | "liability" | "equity" | "income" | "expense";

export interface Posting {
  account: string;
  amount: bigint;
}

export interface JournalInput {
  /** Unique per business event, e.g. "payout:dist-12:wallet-0xabc". */
  idempotencyKey: string;
  kind: string;
  memo?: string;
  externalRef?: string;
  /** Service or user that caused the entry; stored for audit. */
  createdBy: string;
  postings: Posting[];
}

export type LedgerErrorCode =
  | "UNBALANCED"
  | "INSUFFICIENT_BALANCE"
  | "IDEMPOTENCY_CONFLICT"
  | "UNKNOWN_ACCOUNT"
  | "INVALID"
  | "APPEND_ONLY";

export class LedgerError extends Error {
  constructor(
    readonly code: LedgerErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "LedgerError";
  }
}

const MAX_AMOUNT = 999_999_999_999_999_999n; // 18 digits, matches the database check

const journalSchema = z.object({
  idempotencyKey: z.string().min(8).max(200),
  kind: z.string().regex(/^[a-z][a-z0-9_]{2,63}$/),
  memo: z.string().max(500).optional(),
  externalRef: z.string().max(200).optional(),
  createdBy: z.string().min(1).max(100),
  postings: z
    .array(
      z.object({
        account: z.string().min(1).max(128),
        amount: z.bigint().refine((a) => a !== 0n && a <= MAX_AMOUNT && a >= -MAX_AMOUNT, "non-zero, at most 18 digits"),
      }),
    )
    .min(2),
});

function translate(err: unknown): never {
  const e = err as { code?: string; message?: string };
  const msg = e.message ?? "ledger error";
  if (msg.includes("does not balance")) throw new LedgerError("UNBALANCED", msg, { cause: err });
  if (msg.includes("insufficient balance")) throw new LedgerError("INSUFFICIENT_BALANCE", msg, { cause: err });
  if (msg.includes("idempotency key")) throw new LedgerError("IDEMPOTENCY_CONFLICT", msg, { cause: err });
  if (msg.includes("unknown account")) throw new LedgerError("UNKNOWN_ACCOUNT", msg, { cause: err });
  if (msg.includes("append-only")) throw new LedgerError("APPEND_ONLY", msg, { cause: err });
  if (e.code === "23514" || e.code === "22P02") throw new LedgerError("INVALID", msg, { cause: err });
  throw err;
}

export async function openAccount(
  db: pg.ClientBase | pg.Pool,
  account: { code: string; kind: AccountKind; asset: string; allowOverdraft?: boolean },
): Promise<bigint> {
  try {
    const { rows } = await db.query<{ id: string }>("SELECT ledger.open_account($1, $2, $3, $4) AS id", [
      account.code,
      account.kind,
      account.asset,
      account.allowOverdraft ?? false,
    ]);
    return BigInt(rows[0]?.id ?? "0");
  } catch (err) {
    translate(err);
  }
}

/** Posts a balanced journal. Returns the journal id (the same id again for an identical retry). */
export async function postJournal(db: pg.ClientBase | pg.Pool, input: JournalInput): Promise<bigint> {
  const parsed = journalSchema.safeParse(input);
  if (!parsed.success) {
    throw new LedgerError("INVALID", parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  }
  const totals = new Map<string, bigint>();
  for (const p of input.postings) totals.set(p.account, (totals.get(p.account) ?? 0n) + p.amount);
  if (totals.size !== input.postings.length) throw new LedgerError("INVALID", "an account may appear only once per journal");

  const postings = input.postings.map((p) => ({ account: p.account, amount: p.amount.toString() }));
  try {
    const { rows } = await db.query<{ id: string }>(
      "SELECT ledger.post_journal($1, $2, $3, $4, $5, $6::jsonb) AS id",
      [
        input.idempotencyKey,
        input.kind,
        input.memo ?? null,
        input.externalRef ?? null,
        input.createdBy,
        JSON.stringify(postings),
      ],
    );
    return BigInt(rows[0]?.id ?? "0");
  } catch (err) {
    translate(err);
  }
}

/** Current balance of an account (positive = debit). */
export async function balanceOf(db: pg.ClientBase | pg.Pool, code: string): Promise<bigint> {
  const { rows } = await db.query<{ balance: string }>("SELECT balance FROM ledger.balances WHERE code = $1", [code]);
  if (rows.length === 0) throw new LedgerError("UNKNOWN_ACCOUNT", `unknown account ${code}`);
  return BigInt(rows[0]?.balance ?? "0");
}

export interface ChainProblem {
  journalId: bigint;
  problem: string;
}

/** Recomputes every journal hash and link. An empty array means the ledger is intact. */
export async function verifyChain(db: pg.ClientBase | pg.Pool): Promise<ChainProblem[]> {
  const { rows } = await db.query<{ journal_id: string; problem: string }>("SELECT * FROM ledger.verify_chain()");
  return rows.map((r) => ({ journalId: BigInt(r.journal_id), problem: r.problem }));
}

/** Latest journal id and hash, for anchoring the ledger head on-chain. */
export async function chainHead(db: pg.ClientBase | pg.Pool): Promise<{ journalId: bigint; hash: string } | null> {
  const { rows } = await db.query<{ journal_id: string; hash: string }>("SELECT * FROM ledger.chain_head()");
  const r = rows[0];
  return r ? { journalId: BigInt(r.journal_id), hash: r.hash } : null;
}
