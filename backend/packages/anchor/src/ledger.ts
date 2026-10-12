import { createHash } from "node:crypto";
import type pg from "pg";
import type { Hex } from "viem";
import { ZERO_HASH } from "./commitment.ts";

/** The ledger head to anchor: newest journal id and its hash-chain value (0 / zero hash when empty). */
export async function ledgerHead(db: pg.ClientBase | pg.Pool): Promise<{ journalId: bigint; hash: Hex }> {
  const { rows } = await db.query<{ journal_id: string; hash: string }>("SELECT journal_id, hash FROM ledger.chain_head()");
  const r = rows[0];
  if (!r) return { journalId: 0n, hash: ZERO_HASH };
  if (!/^[0-9a-f]{64}$/.test(r.hash)) throw new Error("ledger.chain_head returned a malformed hash");
  return { journalId: BigInt(r.journal_id), hash: `0x${r.hash}` };
}

export interface LedgerRecomputation {
  /** Recomputed hash of every journal, by id. */
  hashes: Map<bigint, Hex>;
  /** Newest journal id (0 when empty). */
  lastId: bigint;
  journals: number;
  problems: string[];
}

interface JournalRow {
  id: string;
  idempotency_key: string;
  kind: string;
  memo: string | null;
  external_ref: string | null;
  created_by: string;
  created_at: string;
  prev_hash: string;
  hash: string;
  postings: [string, string, string][] | null;
}

/**
 * PostgreSQL's jsonb text form of a value: arrays print as "[a, b]" and strings use JSON escaping
 * (", \\, \b, \f, \n, \r, \t, other control characters as \u00xx). JSON.stringify escapes strings the
 * same way.
 */
function jsonbText(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(jsonbText).join(", ")}]`;
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "bigint") return v.toString();
  throw new Error("unsupported value in a ledger digest");
}

/**
 * Recomputes the whole ledger hash chain (L-4) in TypeScript, independently of the database
 * functions `ledger.digest` and `ledger.verify_chain` (a superuser could replace those). The digest is
 * sha256 of the jsonb text of
 *   [prev_hash_hex, id, idempotency_key, kind, memo or "", external_ref or "", created_by,
 *    created_at in UTC with microseconds, [[account_id, asset, amount_text], ...] in posting order].
 * Reads in pages of `pageSize` journals so the ledger never has to fit in one query.
 */
export async function recomputeLedger(db: pg.ClientBase | pg.Pool, pageSize = 5_000): Promise<LedgerRecomputation> {
  const hashes = new Map<bigint, Hex>();
  const problems: string[] = [];
  let prev = "0".repeat(64);
  let after = 0n;
  let journals = 0;
  for (;;) {
    const { rows } = await db.query<JournalRow>(
      `SELECT j.id::text AS id, j.idempotency_key, j.kind, j.memo, j.external_ref, j.created_by,
              to_char(j.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
              encode(j.prev_hash, 'hex') AS prev_hash, encode(j.hash, 'hex') AS hash,
              (SELECT json_agg(json_build_array(p.account_id::text, p.asset, p.amount::text) ORDER BY p.id)
                 FROM ledger.postings p WHERE p.journal_id = j.id) AS postings
       FROM ledger.journal j WHERE j.id > $1 ORDER BY j.id LIMIT $2`,
      [after.toString(), pageSize],
    );
    for (const j of rows) {
      const id = BigInt(j.id);
      journals++;
      if (j.prev_hash !== prev) problems.push(`ledger journal ${j.id}: prev_hash does not match the previous journal`);
      if (!j.postings || j.postings.length < 2) problems.push(`ledger journal ${j.id}: has fewer than two postings`);
      const postings = (j.postings ?? []).map(([account, asset, amount]) => [BigInt(account), asset, amount]);
      const text = jsonbText([j.prev_hash, id, j.idempotency_key, j.kind, j.memo ?? "", j.external_ref ?? "", j.created_by, j.created_at, postings]);
      const digest = createHash("sha256").update(text, "utf8").digest("hex");
      if (digest !== j.hash) problems.push(`ledger journal ${j.id}: content does not match its hash`);
      // Balance per asset (L-1), checked again from the raw rows.
      const totals = new Map<string, bigint>();
      for (const [, asset, amount] of j.postings ?? []) totals.set(asset, (totals.get(asset) ?? 0n) + BigInt(amount));
      if ([...totals.values()].some((t) => t !== 0n)) problems.push(`ledger journal ${j.id}: postings do not balance`);
      // The chain continues from the hash as recomputed, so one edit is reported where it happened
      // and every later journal still links to the stored value.
      hashes.set(id, `0x${digest}`);
      prev = j.hash;
      after = id;
    }
    if (rows.length < pageSize) break;
  }
  return { hashes, lastId: after, journals, problems };
}
