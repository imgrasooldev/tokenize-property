import type pg from "pg";
import type { Address, Hex } from "viem";

export type AnchorStatus = "recorded" | "sent" | "confirmed" | "failed";

export interface AnchorRecord {
  id: bigint;
  anchorChainId: number;
  contract: Address;
  besuChainId: bigint;
  besuBlock: bigint;
  besuBlockHash: Hex;
  ledgerJournalId: bigint;
  ledgerHeadHash: Hex;
  commitment: Hex;
  status: AnchorStatus;
  tx: { hash: Hex; nonce: bigint; from: Address; raw: Hex } | null;
  anchorBlock: bigint | null;
  anchorBlockHash: Hex | null;
  failure: string | null;
  createdAt: Date;
}

interface Row {
  id: string;
  anchor_chain_id: string;
  contract: string;
  besu_chain_id: string;
  besu_block: string;
  besu_block_hash: string;
  ledger_journal_id: string;
  ledger_head_hash: string;
  commitment: string;
  status: AnchorStatus;
  tx_hash: string | null;
  tx_nonce: string | null;
  tx_from: string | null;
  raw_tx: string | null;
  anchor_block: string | null;
  anchor_block_hash: string | null;
  failure: string | null;
  created_at: Date;
}

function toRecord(r: Row): AnchorRecord {
  return {
    id: BigInt(r.id),
    anchorChainId: Number(r.anchor_chain_id),
    contract: r.contract as Address,
    besuChainId: BigInt(r.besu_chain_id),
    besuBlock: BigInt(r.besu_block),
    besuBlockHash: r.besu_block_hash as Hex,
    ledgerJournalId: BigInt(r.ledger_journal_id),
    ledgerHeadHash: r.ledger_head_hash as Hex,
    commitment: r.commitment as Hex,
    status: r.status,
    tx:
      r.tx_hash && r.tx_nonce !== null && r.tx_from && r.raw_tx
        ? { hash: r.tx_hash as Hex, nonce: BigInt(r.tx_nonce), from: r.tx_from as Address, raw: r.raw_tx as Hex }
        : null,
    anchorBlock: r.anchor_block === null ? null : BigInt(r.anchor_block),
    anchorBlockHash: r.anchor_block_hash as Hex | null,
    failure: r.failure,
    createdAt: r.created_at,
  };
}

export interface Target {
  anchorChainId: number;
  contract: Address;
}

type Db = pg.ClientBase | pg.Pool;

/** All anchors of one contract, oldest private block first. */
export async function anchorsOf(db: Db, t: Target): Promise<AnchorRecord[]> {
  const { rows } = await db.query<Row>("SELECT * FROM anchor.anchors WHERE anchor_chain_id = $1 AND contract = $2 ORDER BY besu_block, id", [
    t.anchorChainId,
    t.contract.toLowerCase(),
  ]);
  return rows.map(toRecord);
}

export async function openAnchor(db: Db, t: Target): Promise<AnchorRecord | null> {
  const { rows } = await db.query<Row>(
    "SELECT * FROM anchor.anchors WHERE anchor_chain_id = $1 AND contract = $2 AND status IN ('recorded', 'sent')",
    [t.anchorChainId, t.contract.toLowerCase()],
  );
  return rows[0] ? toRecord(rows[0]) : null;
}

/** Newest anchor that did not fail (open or confirmed). */
export async function lastAnchor(db: Db, t: Target): Promise<AnchorRecord | null> {
  const { rows } = await db.query<Row>(
    "SELECT * FROM anchor.anchors WHERE anchor_chain_id = $1 AND contract = $2 AND status <> 'failed' ORDER BY besu_block DESC LIMIT 1",
    [t.anchorChainId, t.contract.toLowerCase()],
  );
  return rows[0] ? toRecord(rows[0]) : null;
}

export async function getAnchor(db: Db, id: bigint): Promise<AnchorRecord> {
  const { rows } = await db.query<Row>("SELECT * FROM anchor.anchors WHERE id = $1", [id.toString()]);
  if (!rows[0]) throw new Error(`anchor ${id.toString()} not found`);
  return toRecord(rows[0]);
}

export async function recordAnchor(
  db: Db,
  t: Target,
  a: { besuChainId: bigint; besuBlock: bigint; besuBlockHash: Hex; ledgerJournalId: bigint; ledgerHeadHash: Hex; commitment: Hex },
  actor: string,
): Promise<bigint> {
  const { rows } = await db.query<{ id: string }>("SELECT anchor.record($1, $2, $3, $4, $5, $6, $7, $8, $9) AS id", [
    t.anchorChainId,
    t.contract.toLowerCase(),
    a.besuChainId.toString(),
    a.besuBlock.toString(),
    a.besuBlockHash,
    a.ledgerJournalId.toString(),
    a.ledgerHeadHash,
    a.commitment,
    actor,
  ]);
  return BigInt(rows[0]?.id ?? "0");
}

export async function markSent(db: Db, id: bigint, tx: { hash: Hex; nonce: bigint; from: Address; raw: Hex }, actor: string): Promise<boolean> {
  const { rows } = await db.query<{ ok: boolean }>("SELECT anchor.mark_sent($1, $2, $3, $4, $5, $6) AS ok", [
    id.toString(),
    tx.hash,
    tx.nonce.toString(),
    tx.from.toLowerCase(),
    tx.raw.toLowerCase(),
    actor,
  ]);
  return rows[0]?.ok === true;
}

export async function confirmAnchor(db: Db, id: bigint, txHash: Hex, block: bigint, blockHash: Hex, actor: string): Promise<void> {
  await db.query("SELECT anchor.confirm($1, $2, $3, $4, $5)", [id.toString(), txHash, block.toString(), blockHash, actor]);
}

export async function clearDropped(db: Db, id: bigint, txHash: Hex, reason: string, actor: string): Promise<void> {
  await db.query("SELECT anchor.clear_dropped($1, $2, $3, $4)", [id.toString(), txHash, reason, actor]);
}

export async function failAnchor(db: Db, id: bigint, reason: string, actor: string): Promise<void> {
  await db.query("SELECT anchor.fail($1, $2, $3)", [id.toString(), reason, actor]);
}
