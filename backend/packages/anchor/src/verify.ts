import type pg from "pg";
import type { Hex } from "viem";
import type { AnchorChain, AnchoredEvent, BesuSource } from "./chains.ts";
import { computeCommitment, ZERO_HASH } from "./commitment.ts";
import { recomputeLedger } from "./ledger.ts";
import { readProblem } from "./network.ts";
import { anchorsOf, type Target } from "./store.ts";

export interface VerifyOptions {
  target: Target;
  besuChainId: number;
  /** First anchor-chain block to scan (the deployment block). */
  fromBlock: bigint;
  /** Last anchor-chain block to scan; default: the head. */
  toBlock?: bigint;
  /** eth_getLogs window; providers limit the range (Besu 5,000; many L2 RPCs less). */
  logWindow?: bigint;
}

export interface VerifyReport {
  ok: boolean;
  /** Anchors found on the public chain. */
  anchors: number;
  /** Anchor records in the database. */
  records: number;
  ledgerJournals: number;
  lastAnchoredBlock: bigint;
  scanned: { from: bigint; to: bigint; windows: number };
  problems: string[];
  ms: number;
}

/**
 * Checks every public anchor against the private chain and the ledger (threats CH-1 and D-1):
 *  - every Anchored event has a database record whose components hash to the public commitment
 *    (an edited record no longer matches);
 *  - the private chain still has the anchored hash at that height (a rewritten history does not);
 *  - the ledger, recomputed independently from its rows, still has the anchored head hash at the
 *    anchored journal (an edited, deleted or re-hashed journal does not), and its whole hash chain is
 *    intact;
 *  - every confirmed record is on the public chain, in the recorded transaction and block, and that
 *    block is still part of the anchor chain; the contract's last anchored block matches.
 * Reads only; never sends anything.
 */
export async function verifyAnchors(db: pg.ClientBase | pg.Pool, chain: AnchorChain, besu: BesuSource, o: VerifyOptions): Promise<VerifyReport> {
  const t0 = performance.now();
  const problems: string[] = [];
  const { target } = o;

  const [anchorChainId, besuChainId] = await Promise.all([chain.chainId(), besu.chainId()]);
  if (anchorChainId !== target.anchorChainId) throw new Error(`the anchor RPC serves chain ${String(anchorChainId)}, expected ${String(target.anchorChainId)}`);
  if (besuChainId !== o.besuChainId) throw new Error(`the private RPC serves chain ${String(besuChainId)}, expected ${String(o.besuChainId)}`);
  const policy = readProblem({ anchorChainId, besuChainId });
  if (policy) throw new Error(policy);

  // 1. Public anchors, read in windows.
  const window = o.logWindow ?? 2_000n;
  if (window < 1n || window > 5_000n) throw new Error("log window must be 1..5000 blocks");
  const to = o.toBlock ?? (await chain.head());
  const events: AnchoredEvent[] = [];
  let windows = 0;
  for (let from = o.fromBlock; from <= to; from += window) {
    const end = from + window - 1n < to ? from + window - 1n : to;
    events.push(...(await chain.anchoredEvents(target.contract, from, end)));
    windows++;
  }
  events.sort((a, b) => (a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1));
  for (let i = 1; i < events.length; i++) {
    const prev = events.at(i - 1);
    const cur = events.at(i);
    if (prev && cur && cur.besuBlock <= prev.besuBlock) problems.push(`public anchors not strictly increasing at private block ${cur.besuBlock.toString()}`);
  }
  const lastOnChain = await chain.lastAnchoredBlock(target.contract);
  const lastEvent = events.at(-1)?.besuBlock ?? 0n;
  if (lastOnChain !== lastEvent) {
    problems.push(`contract reports last anchored block ${lastOnChain.toString()} but the scanned events end at ${lastEvent.toString()} (scan range too short?)`);
  }

  // 2. Database records and the independent ledger recomputation.
  const records = await anchorsOf(db, target);
  const live = new Map(records.filter((r) => r.status !== "failed").map((r) => [r.besuBlock, r]));
  const ledger = await recomputeLedger(db);
  problems.push(...ledger.problems);

  for (const ev of events) {
    const where = `anchor of private block ${ev.besuBlock.toString()} (tx ${ev.txHash})`;
    const rec = live.get(ev.besuBlock);
    if (!rec) {
      problems.push(`${where}: no database record (written by an unknown party, or the record was deleted)`);
      continue;
    }
    // a) the stored components still hash to the public value
    let recomputed: Hex | null = null;
    try {
      recomputed = computeCommitment(rec);
    } catch (e) {
      problems.push(`${where}: stored components are invalid (${(e as Error).message})`);
    }
    if (recomputed !== null && recomputed !== ev.commitment) problems.push(`${where}: the database record does not hash to the public commitment (record edited)`);
    if (rec.besuChainId !== BigInt(o.besuChainId)) problems.push(`${where}: anchored for private chain ${rec.besuChainId.toString()}, not ${String(o.besuChainId)}`);
    // b) the private chain still has that block (CH-1)
    const besuHash = await besu.blockHash(rec.besuBlock).catch(() => null);
    if (besuHash === null) problems.push(`${where}: the private chain no longer has block ${rec.besuBlock.toString()}`);
    else if (besuHash !== rec.besuBlockHash) {
      problems.push(`${where}: PRIVATE CHAIN REWRITTEN: block ${rec.besuBlock.toString()} is now ${besuHash}, anchored ${rec.besuBlockHash}`);
    }
    // c) the ledger still has that head (D-1)
    if (rec.ledgerJournalId > 0n) {
      const h = ledger.hashes.get(rec.ledgerJournalId);
      if (!h) problems.push(`${where}: LEDGER CHANGED: anchored journal ${rec.ledgerJournalId.toString()} is missing`);
      else if (h !== rec.ledgerHeadHash) {
        problems.push(`${where}: LEDGER CHANGED: journal ${rec.ledgerJournalId.toString()} now hashes to ${h}, anchored ${rec.ledgerHeadHash}`);
      }
    } else if (rec.ledgerHeadHash !== ZERO_HASH) problems.push(`${where}: empty ledger anchored with a non-zero head`);
    // d) the record points at this very transaction
    if (rec.status === "confirmed" && (rec.tx?.hash !== ev.txHash || rec.anchorBlock !== ev.blockNumber || rec.anchorBlockHash !== ev.blockHash)) {
      problems.push(`${where}: recorded as transaction ${rec.tx?.hash ?? "none"} in block ${rec.anchorBlock?.toString() ?? "none"}`);
    }
  }

  const onChain = new Set(events.map((e) => e.besuBlock));
  for (const rec of records) {
    if (rec.status !== "confirmed") continue;
    if (!onChain.has(rec.besuBlock)) {
      problems.push(`anchor record ${rec.id.toString()} (private block ${rec.besuBlock.toString()}) is confirmed but not on the public chain`);
      continue;
    }
    if (rec.anchorBlock !== null && (await chain.blockHash(rec.anchorBlock)) !== rec.anchorBlockHash) {
      problems.push(`anchor record ${rec.id.toString()}: anchor-chain block ${rec.anchorBlock.toString()} was replaced (re-org)`);
    }
  }

  return {
    ok: problems.length === 0,
    anchors: events.length,
    records: records.length,
    ledgerJournals: ledger.journals,
    lastAnchoredBlock: lastOnChain,
    scanned: { from: o.fromBlock, to, windows },
    problems,
    ms: Math.round(performance.now() - t0),
  };
}
