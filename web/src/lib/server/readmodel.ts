import type { Address, Hex } from "viem";
import { findProperty } from "../properties";
import { deploymentId, latestDeployment } from "./chain";
import { db } from "./db";

/**
 * The indexer's read model of the chain (schema `chain`, ADR 0006), read with the website's own
 * role (pt_chain_reader through pt_web). Every figure is "as of" the indexer cursor; nothing on a
 * page waits for the node (ADR 0001, ADR 0010 §1). Every function returns null when the read model
 * is unavailable, so pages say so instead of guessing.
 */

export interface IndexStatus {
  block: bigint;
  updatedAt: Date;
  halted: string | null;
  /** The cursor has not moved for 60 s (indexer stopped or far behind). */
  stale: boolean;
  /** Time of the cursor block (the last block fully applied), when the read model holds it. */
  blockTime: Date | null;
}

let statusCache: { at: number; value: Promise<IndexStatus | null> } | null = null;

export function indexStatus(): Promise<IndexStatus | null> {
  if (statusCache && Date.now() - statusCache.at < 500) return statusCache.value;
  const value = readStatus();
  statusCache = { at: Date.now(), value };
  return value;
}

async function readStatus(): Promise<IndexStatus | null> {
  const id = deploymentId();
  if (!id) return null;
  try {
    const { rows } = await (await db()).query<{ block_number: string; updated_at: Date; halt_reason: string | null; age: number; block_time: Date | null }>(
      `SELECT c.block_number, c.updated_at, c.halt_reason, extract(epoch FROM now() - c.updated_at)::float8 AS age, b.block_time
       FROM chain.cursors c LEFT JOIN chain.blocks b ON b.number = c.block_number WHERE c.deployment = $1`,
      [id],
    );
    const r = rows[0];
    return r
      ? { block: BigInt(r.block_number), updatedAt: r.updated_at, halted: r.halt_reason, stale: r.age > 60, blockTime: r.block_time }
      : null;
  } catch {
    return null;
  }
}

export interface LiveToken {
  address: Address;
  supply: bigint;
  cap: bigint;
  paused: boolean;
  /** PauseGuard's reason for the current pause (e.g. "transfer-closed", S-04); null when not paused or not given. */
  pauseReason: string | null;
  symbol: string;
  /** Block the figures are from (the indexer cursor). */
  asOfBlock: bigint;
}

const TOKEN_TTL_MS = 1_000;
const tokenCache = new Map<string, { at: number; value: Promise<LiveToken | null> }>();

/**
 * The live property's token figures from the read model (supply, trustee cap, pause state).
 * `fresh` skips the 1-second cache (money-moving pre-checks). The contracts and the signing
 * service re-check every rule against the chain regardless.
 */
export function liveToken(symbol: string, fresh = false): Promise<LiveToken | null> {
  const hit = tokenCache.get(symbol);
  if (!fresh && hit && Date.now() - hit.at < TOKEN_TTL_MS) return hit.value;
  const value = readToken(symbol);
  tokenCache.set(symbol, { at: Date.now(), value });
  void value.then((v) => {
    if (v === null) tokenCache.delete(symbol); // do not cache an outage
  });
  return value;
}

async function readToken(symbol: string): Promise<LiveToken | null> {
  // The prototype has one live property, backed by the local deployment's token.
  if (findProperty(symbol)?.status !== "live") return null;
  const token = latestDeployment()?.get("token");
  if (!token) return null;
  try {
    const { rows } = await (await db()).query<{ total_supply: string; trustee_cap: string; paused: boolean; pause_reason: string | null; block_number: string }>(
      `SELECT t.total_supply::text, t.trustee_cap::text, t.paused, t.pause_reason, c.block_number
       FROM chain.tokens t JOIN chain.cursors c ON c.deployment = t.deployment WHERE t.token = $1`,
      [token],
    );
    const r = rows[0];
    if (!r) return null;
    return {
      address: token,
      supply: BigInt(r.total_supply),
      cap: BigInt(r.trustee_cap),
      paused: r.paused,
      pauseReason: r.paused ? r.pause_reason : null,
      symbol,
      asOfBlock: BigInt(r.block_number),
    };
  } catch {
    return null;
  }
}

/** A wallet's balance of the live token in the read model; null if unavailable. */
export async function holdingOf(wallet: Address): Promise<bigint | null> {
  const token = latestDeployment()?.get("token");
  if (!token) return null;
  try {
    const { rows } = await (await db()).query<{ balance: string }>("SELECT balance::text FROM chain.holdings WHERE token = $1 AND holder = $2", [token, wallet.toLowerCase()]);
    return BigInt(rows[0]?.balance ?? "0");
  } catch {
    return null;
  }
}

/**
 * Whether the identity registry lists this wallet as registered (read model). The signing service
 * checks `isVerified` on chain before any mint or delivery; this is the website's pre-check.
 */
export async function registeredOnChain(wallet: Address): Promise<boolean | null> {
  const ir = latestDeployment()?.get("ir");
  if (!ir) return null;
  try {
    const { rows } = await (await db()).query<{ ok: boolean }>(
      "SELECT registered AND NOT identity_stale AS ok FROM chain.investors WHERE registry = $1 AND wallet = $2",
      [ir, wallet.toLowerCase()],
    );
    return rows[0]?.ok === true;
  } catch {
    return null;
  }
}

/** The ONCHAINID the registry records for a registered wallet (read model). */
export async function registeredIdentity(wallet: Address): Promise<Address | null> {
  const ir = latestDeployment()?.get("ir");
  if (!ir) return null;
  try {
    const { rows } = await (await db()).query<{ identity: string | null }>(
      "SELECT identity FROM chain.investors WHERE registry = $1 AND wallet = $2 AND registered",
      [ir, wallet.toLowerCase()],
    );
    return (rows[0]?.identity ?? null) as Address | null;
  } catch {
    return null;
  }
}

export interface Issuance {
  account: string;
  amount: bigint;
  txHash: Hex;
  blockNumber: bigint;
  blockTime: Date;
}

/** The IssuanceGuard mint that used this refId, if the read model has it (refIds are single-use, I-11). */
export async function issuanceOf(refId: Hex): Promise<Issuance | null | undefined> {
  const issuance = latestDeployment()?.get("issuance");
  if (!issuance) return undefined;
  try {
    const { rows } = await (await db()).query<{ account: string; amount: string; tx_hash: Hex; block_number: string; block_time: Date }>(
      `SELECT i.account, i.amount::text, i.tx_hash, i.block_number, b.block_time FROM chain.issuances i
       JOIN chain.blocks b ON b.number = i.block_number WHERE i.guard = $1 AND i.ref_id = $2 AND i.kind = 'mint'`,
      [issuance, refId.toLowerCase()],
    );
    const r = rows[0];
    return r ? { account: r.account, amount: BigInt(r.amount), txHash: r.tx_hash, blockNumber: BigInt(r.block_number), blockTime: r.block_time } : null;
  } catch {
    return undefined;
  }
}

/** Which of these refIds the read model shows as used (one query for a whole list). */
export async function usedRefs(refIds: Hex[]): Promise<Set<string> | null> {
  const issuance = latestDeployment()?.get("issuance");
  if (!issuance) return null;
  if (refIds.length === 0) return new Set();
  try {
    const { rows } = await (await db()).query<{ ref_id: string }>("SELECT ref_id FROM chain.issuances WHERE guard = $1 AND ref_id = ANY($2)", [
      issuance,
      refIds.map((r) => r.toLowerCase()),
    ]);
    return new Set(rows.map((r) => r.ref_id));
  } catch {
    return null;
  }
}

/** Transfers of the live token from `from` in one transaction (read model); undefined if unavailable. */
export async function transfersInTx(from: Address, txHash: Hex): Promise<{ to: string; amount: bigint; blockNumber: bigint }[] | undefined> {
  const token = latestDeployment()?.get("token");
  if (!token) return undefined;
  try {
    const { rows } = await (await db()).query<{ to_addr: string; amount: string; block_number: string }>(
      "SELECT to_addr, amount::text, block_number FROM chain.transfers WHERE from_addr = $1 AND tx_hash = $2 AND token = $3",
      [from.toLowerCase(), txHash.toLowerCase(), token],
    );
    return rows.map((r) => ({ to: r.to_addr, amount: BigInt(r.amount), blockNumber: BigInt(r.block_number) }));
  } catch {
    return undefined;
  }
}

export interface DistributionRow {
  id: bigint;
  status: "published" | "rejected" | "finalized" | "paid";
  recordBlock: bigint;
  publishedAt: Date;
  root: Hex;
  totalPaisa: bigint;
  statementHash: Hex;
  rejectReason: string | null;
  payoutBatchHash: Hex | null;
  /** Block and time of the latest status change (the publication while still "published"). */
  updatedBlock: bigint;
  updatedAt: Date | null;
}

/** Rent distributions of the live token, newest first (read model); null if unavailable. */
export async function distributionsOfToken(limit = 24): Promise<DistributionRow[] | null> {
  const d = latestDeployment();
  const registry = d?.get("distributions");
  const token = d?.get("token");
  if (!registry || !token) return null;
  try {
    const { rows } = await (await db()).query<{
      id: string;
      status: DistributionRow["status"];
      record_block: string;
      block_time: Date;
      merkle_root: Hex;
      total_paisa: string;
      statement_hash: Hex;
      reject_reason: string | null;
      payout_batch_hash: Hex | null;
      updated_block: string;
      updated_time: Date | null;
    }>(
      `SELECT d.id::text, d.status, d.record_block, b.block_time, d.merkle_root, d.total_paisa::text, d.statement_hash,
              d.reject_reason, d.payout_batch_hash, d.updated_block, u.block_time AS updated_time
       FROM chain.distributions d JOIN chain.blocks b ON b.number = d.published_block
       LEFT JOIN chain.blocks u ON u.number = d.updated_block
       WHERE d.registry = $1 AND d.token = $2 ORDER BY d.id DESC LIMIT $3`,
      [registry, token, limit],
    );
    return rows.map((r) => ({
      id: BigInt(r.id),
      status: r.status,
      recordBlock: BigInt(r.record_block),
      publishedAt: r.block_time,
      root: r.merkle_root,
      totalPaisa: BigInt(r.total_paisa),
      statementHash: r.statement_hash,
      rejectReason: r.reject_reason,
      payoutBatchHash: r.payout_batch_hash,
      updatedBlock: BigInt(r.updated_block),
      updatedAt: r.updated_time,
    }));
  } catch {
    return null;
  }
}

/** Registered investors and holders in the read model (public, aggregate). */
export async function registerFigures(): Promise<{ registered: number; holders: number } | null> {
  const d = latestDeployment();
  const ir = d?.get("ir");
  const token = d?.get("token");
  if (!ir || !token) return null;
  try {
    const { rows } = await (await db()).query<{ registered: string; holders: string }>(
      `SELECT (SELECT count(*) FROM chain.investors WHERE registry = $1 AND registered) AS registered,
              (SELECT count(*) FROM chain.holdings WHERE token = $2 AND balance > 0) AS holders`,
      [ir, token],
    );
    const r = rows[0];
    return r ? { registered: Number(r.registered), holders: Number(r.holders) } : null;
  } catch {
    return null;
  }
}

export interface DocumentRow {
  id: bigint;
  docType: number;
  sha256: Hex;
  uri: string;
  supersededBy: bigint | null;
  addedBlock: bigint;
  addedAt: Date | null;
}

/**
 * DocumentRegistry records of the live token, newest first (read model, S-07 PV-10): hashes and
 * `pt-doc://` references only; the documents themselves are never on the chain.
 */
export async function documentsOfToken(limit = 200): Promise<DocumentRow[] | null> {
  const d = latestDeployment();
  const registry = d?.get("documents");
  const token = d?.get("token");
  if (!registry || !token) return null;
  try {
    const { rows } = await (await db()).query<{
      id: string;
      doc_type: number;
      sha256_hash: Hex;
      uri: string;
      superseded_by: string | null;
      added_block: string;
      block_time: Date | null;
    }>(
      `SELECT d.id::text, d.doc_type, d.sha256_hash, d.uri, d.superseded_by::text, d.added_block, b.block_time
       FROM chain.documents d LEFT JOIN chain.blocks b ON b.number = d.added_block
       WHERE d.registry = $1 AND d.token = $2 ORDER BY d.id DESC LIMIT $3`,
      [registry, token, limit],
    );
    return rows.map((r) => ({
      id: BigInt(r.id),
      docType: r.doc_type,
      sha256: r.sha256_hash,
      uri: r.uri,
      supersededBy: r.superseded_by === null ? null : BigInt(r.superseded_by),
      addedBlock: BigInt(r.added_block),
      addedAt: r.block_time,
    }));
  } catch {
    return null;
  }
}
