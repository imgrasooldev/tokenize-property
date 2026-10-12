import type pg from "pg";

/**
 * Typed reads of the read model for services and portals (run as pt_chain_reader). Every query is
 * served by an index; amounts are bigint. The chain itself is never in the read path (ADR 0001).
 */

type Db = pg.ClientBase | pg.Pool;

export interface IndexStatus {
  deployment: string;
  blockNumber: bigint;
  updatedAt: Date;
  halted: string | null;
}

/** How far the read model is; the UI shows "pending" for anything newer (threat D-3). */
export async function indexStatus(db: Db, deployment: string): Promise<IndexStatus | null> {
  const { rows } = await db.query<{ block_number: string; updated_at: Date; halt_reason: string | null }>(
    "SELECT block_number, updated_at, halt_reason FROM chain.cursors WHERE deployment = $1", [deployment]);
  const r = rows[0];
  return r ? { deployment, blockNumber: BigInt(r.block_number), updatedAt: r.updated_at, halted: r.halt_reason } : null;
}

export interface Holding {
  token: string;
  holder: string;
  balance: bigint;
}

/** Largest holders of a token. */
export async function holders(db: Db, token: string, limit = 100): Promise<Holding[]> {
  const { rows } = await db.query<{ holder: string; balance: string }>(
    "SELECT holder, balance::text FROM chain.holdings WHERE token = $1 AND balance > 0 ORDER BY balance DESC, holder LIMIT $2",
    [token.toLowerCase(), Math.min(Math.max(limit, 1), 1000)]);
  return rows.map((r) => ({ token: token.toLowerCase(), holder: r.holder, balance: BigInt(r.balance) }));
}

export interface PortfolioLine extends Holding {
  frozenAmount: bigint;
  addressFrozen: boolean;
  paused: boolean;
}

/** One investor's holdings across tokens, with freeze and pause state. */
export async function portfolio(db: Db, holder: string): Promise<PortfolioLine[]> {
  const { rows } = await db.query<{ token: string; balance: string; frozen_amount: string | null; address_frozen: boolean | null; paused: boolean }>(
    `SELECT h.token, h.balance::text, f.frozen_amount::text, f.address_frozen, t.paused
     FROM chain.holdings h
     JOIN chain.tokens t ON t.token = h.token
     LEFT JOIN chain.freezes f ON f.token = h.token AND f.holder = h.holder
     WHERE h.holder = $1 AND h.balance > 0 ORDER BY h.token`,
    [holder.toLowerCase()]);
  return rows.map((r) => ({
    token: r.token, holder: holder.toLowerCase(), balance: BigInt(r.balance), frozenAmount: BigInt(r.frozen_amount ?? "0"),
    addressFrozen: r.address_frozen ?? false, paused: r.paused,
  }));
}

export interface TransferRow {
  blockNumber: bigint;
  logIndex: number;
  blockTime: Date;
  token: string;
  txHash: string;
  from: string;
  to: string;
  amount: bigint;
  kind: "mint" | "burn" | "transfer";
}

/** Latest transfers in or out of an address (both directions use an index). */
export async function transfersOf(db: Db, address: string, limit = 50): Promise<TransferRow[]> {
  const n = Math.min(Math.max(limit, 1), 500);
  const { rows } = await db.query<{ block_number: string; log_index: number; block_time: Date; token: string; tx_hash: string; from_addr: string; to_addr: string; amount: string; kind: TransferRow["kind"] }>(
    `SELECT t.block_number, t.log_index, b.block_time, t.token, t.tx_hash, t.from_addr, t.to_addr, t.amount::text, t.kind
     FROM (
       (SELECT * FROM chain.transfers WHERE from_addr = $1 ORDER BY block_number DESC, log_index DESC LIMIT $2)
       UNION
       (SELECT * FROM chain.transfers WHERE to_addr = $1 ORDER BY block_number DESC, log_index DESC LIMIT $2)
     ) t JOIN chain.blocks b ON b.number = t.block_number
     ORDER BY t.block_number DESC, t.log_index DESC LIMIT $2`,
    [address.toLowerCase(), n]);
  return rows.map((r) => ({
    blockNumber: BigInt(r.block_number), logIndex: r.log_index, blockTime: r.block_time, token: r.token, txHash: r.tx_hash,
    from: r.from_addr, to: r.to_addr, amount: BigInt(r.amount), kind: r.kind,
  }));
}

export interface DistributionRow {
  id: bigint;
  token: string;
  recordBlock: bigint;
  merkleRoot: string;
  totalPaisa: bigint;
  statementHash: string;
  status: "published" | "rejected" | "finalized" | "paid";
  publishedAt: Date;
}

/** Rent distributions of a token, newest first. */
export async function distributionsOf(db: Db, token: string, limit = 50): Promise<DistributionRow[]> {
  const { rows } = await db.query<{ id: string; record_block: string; merkle_root: string; total_paisa: string; statement_hash: string; status: DistributionRow["status"]; block_time: Date }>(
    `SELECT d.id::text, d.record_block, d.merkle_root, d.total_paisa::text, d.statement_hash, d.status, b.block_time
     FROM chain.distributions d JOIN chain.blocks b ON b.number = d.published_block
     WHERE d.token = $1 ORDER BY d.id DESC LIMIT $2`,
    [token.toLowerCase(), Math.min(Math.max(limit, 1), 500)]);
  return rows.map((r) => ({
    id: BigInt(r.id), token: token.toLowerCase(), recordBlock: BigInt(r.record_block), merkleRoot: r.merkle_root, totalPaisa: BigInt(r.total_paisa),
    statementHash: r.statement_hash, status: r.status, publishedAt: r.block_time,
  }));
}
