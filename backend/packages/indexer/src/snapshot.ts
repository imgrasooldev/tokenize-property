import type pg from "pg";
import type { Deployment } from "./deployment.ts";
import { Digest, eventLine, freezeActionLine, transferLine, type Snapshot } from "./model.ts";

/** Rows per page when streaming history tables (keyset paging, bounded memory). */
const PAGE = 5_000;

type Db = pg.ClientBase;

/**
 * Reads one deployment's read model in the same shape as ReadModel.snapshot(). Call it inside a
 * REPEATABLE READ transaction to get one consistent picture while the indexer keeps writing.
 */
export async function readSnapshot(db: Db, d: Deployment): Promise<Snapshot> {
  const c = d.contracts;
  const token = await db.query<{ total_supply: string; trustee_cap: string; paused: boolean; pause_reason: string | null; paused_by: string | null }>(
    "SELECT total_supply::text, trustee_cap::text, paused, pause_reason, paused_by FROM chain.tokens WHERE deployment = $1",
    [d.id],
  );
  const t = token.rows[0];
  if (!t) throw new Error(`deployment ${d.id} is not registered`);

  const holdings = await db.query<{ holder: string; balance: string }>(
    "SELECT holder, balance::text FROM chain.holdings WHERE token = $1 ORDER BY holder", [c.token]);
  const freezes = await db.query<{ holder: string; address_frozen: boolean; frozen_amount: string }>(
    "SELECT holder, address_frozen, frozen_amount::text FROM chain.freezes WHERE token = $1 ORDER BY holder", [c.token]);
  const issuances = await db.query<{ ref_id: string; kind: string; account: string; amount: string; block: string }>(
    "SELECT ref_id, kind, account, amount::text, block_number::text AS block FROM chain.issuances WHERE guard = $1 ORDER BY ref_id",
    [c.issuance ?? null]);
  const distributions = await db.query<{
    id: string; token: string; record_block: string; merkle_root: string; total_paisa: string; statement_hash: string;
    status: string; reject_reason: string | null; payout_batch_hash: string | null;
  }>(
    `SELECT id::text, token, record_block::text, merkle_root, total_paisa::text, statement_hash, status, reject_reason, payout_batch_hash
     FROM chain.distributions WHERE registry = $1 ORDER BY id::text`, [c.distributions ?? null]);
  const documents = await db.query<{ id: string; token: string; doc_type: number; sha256_hash: string; uri: string; superseded_by: string | null }>(
    "SELECT id::text, token, doc_type, sha256_hash, uri, superseded_by::text FROM chain.documents WHERE registry = $1 ORDER BY id::text",
    [c.documents ?? null]);
  const recoveries = await db.query<{
    id: string; kind: string; from_addr: string; to_addr: string; onchain_id: string; amount: string; evidence_hash: string;
    eta: string; status: string; cancelled_by: string | null;
  }>(
    `SELECT id::text, kind, from_addr, to_addr, onchain_id, amount::text, evidence_hash, eta::text, status, cancelled_by
     FROM chain.recoveries WHERE guard = $1 ORDER BY id::text`, [c.recovery ?? null]);
  const investors = await db.query<{ wallet: string; identity: string | null; country: number | null; registered: boolean; identity_stale: boolean }>(
    "SELECT wallet, identity, country, registered, identity_stale FROM chain.investors WHERE registry = $1 ORDER BY wallet",
    [c.identityRegistry ?? null]);

  const events = new Digest();
  await page(db, "SELECT block_number::text AS b, log_index AS l, block_hash, tx_hash, tx_index, address, name, args, topics, data FROM chain.events", d.id,
    (r: { b: string; l: number; block_hash: string; tx_hash: string; tx_index: number; address: string; name: string | null; args: unknown; topics: string[]; data: string }) => {
      events.add(eventLine({ blockNumber: r.b, logIndex: r.l, blockHash: r.block_hash, txHash: r.tx_hash, txIndex: r.tx_index, address: r.address, name: r.name, args: r.args, topics: r.topics, data: r.data }));
    });
  const transfers = new Digest();
  await page(db, "SELECT block_number::text AS b, log_index AS l, tx_hash, from_addr, to_addr, amount::text, kind FROM chain.transfers", d.id,
    (r: { b: string; l: number; tx_hash: string; from_addr: string; to_addr: string; amount: string; kind: string }) => {
      transfers.add(transferLine({ blockNumber: r.b, logIndex: r.l, txHash: r.tx_hash, from: r.from_addr, to: r.to_addr, amount: r.amount, kind: r.kind }));
    });
  const freezeActions = new Digest();
  await page(db, "SELECT block_number::text AS b, log_index AS l, holder, scope, frozen, amount::text, case_id FROM chain.freeze_actions", d.id,
    (r: { b: string; l: number; holder: string; scope: string; frozen: boolean; amount: string | null; case_id: string }) => {
      freezeActions.add(freezeActionLine({ blockNumber: r.b, logIndex: r.l, holder: r.holder, scope: r.scope, frozen: r.frozen, amount: r.amount, caseId: r.case_id }));
    });

  return {
    token: { totalSupply: t.total_supply, trusteeCap: t.trustee_cap, paused: t.paused, pauseReason: t.pause_reason, pausedBy: t.paused_by },
    holdings: Object.fromEntries(holdings.rows.map((r) => [r.holder, r.balance])),
    freezes: Object.fromEntries(freezes.rows.map((r) => [r.holder, { addressFrozen: r.address_frozen, frozenAmount: r.frozen_amount }])),
    issuances: Object.fromEntries(issuances.rows.map((r) => [r.ref_id, { kind: r.kind, account: r.account, amount: r.amount, block: r.block }])),
    distributions: Object.fromEntries(distributions.rows.map((r) => [r.id, {
      token: r.token, recordBlock: r.record_block, merkleRoot: r.merkle_root, totalPaisa: r.total_paisa, statementHash: r.statement_hash,
      status: r.status, rejectReason: r.reject_reason, payoutBatchHash: r.payout_batch_hash,
    }])),
    documents: Object.fromEntries(documents.rows.map((r) => [r.id, { token: r.token, docType: r.doc_type, sha256Hash: r.sha256_hash, uri: r.uri, supersededBy: r.superseded_by }])),
    recoveries: Object.fromEntries(recoveries.rows.map((r) => [r.id, {
      kind: r.kind, from: r.from_addr, to: r.to_addr, onchainId: r.onchain_id, amount: r.amount, evidenceHash: r.evidence_hash, eta: r.eta,
      status: r.status, cancelledBy: r.cancelled_by,
    }])),
    investors: Object.fromEntries(investors.rows.map((r) => [r.wallet, { identity: r.identity, country: r.country, registered: r.registered, identityStale: r.identity_stale }])),
    counts: { events: events.count, transfers: transfers.count, freezeActions: freezeActions.count },
    digests: { events: events.hex(), transfers: transfers.hex(), freezeActions: freezeActions.hex() },
  };
}

/** Streams a history table of one deployment in (block_number, log_index) order. `select` is a fixed query from this file. */
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- R types the rows of the fixed query the caller passes
async function page<R extends { b: string; l: number }>(db: Db, select: string, deployment: string, each: (row: R) => void): Promise<void> {
  let block = "-1";
  let log = -1;
  for (;;) {
    const { rows } = await db.query<R>(
      `${select} WHERE deployment = $1 AND (block_number, log_index) > ($2::bigint, $3::integer) ORDER BY block_number, log_index LIMIT ${String(PAGE)}`,
      [deployment, block, log],
    );
    for (const r of rows) each(r);
    const last = rows.at(-1);
    if (!last || rows.length < PAGE) return;
    block = last.b;
    log = last.l;
  }
}
