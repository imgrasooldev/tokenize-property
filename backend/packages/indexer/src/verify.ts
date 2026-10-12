import { distributionRegistryAbi, documentRegistryAbi, identityRegistryAbi, issuanceGuardAbi, recoveryGuardAbi, tokenAbi } from "@pt/contracts";
import type pg from "pg";
import type { PublicClient } from "viem";
import { decodeLog } from "./decode.ts";
import { rolesByAddress, type Address, type Deployment, type Hex } from "./deployment.ts";
import { MAX_WINDOW } from "./indexer.ts";
import { diffSnapshots, own, ReadModel, type Snapshot } from "./model.ts";
import { readSnapshot } from "./snapshot.ts";
import type { ChainSource } from "./source.ts";

export interface VerifyReport {
  ok: boolean;
  deployment: string;
  /** The read model's cursor when the check started: everything is compared as of this block. */
  pinnedBlock: bigint;
  events: number;
  holders: number;
  /** Contract reads made against the chain state at the pinned block. */
  stateReads: number;
  problems: string[];
  ms: number;
}

const ZERO = "0x0000000000000000000000000000000000000000";
const DIST_STATUS = ["none", "published", "rejected", "finalized", "paid"] as const;
const RECOVERY_STATUS = ["none", "pending", "executed", "cancelled"] as const;

/**
 * Full check of the read model against the chain (threat D-3), read-only:
 *  1. Takes one consistent snapshot of the read model (REPEATABLE READ) and pins its cursor block P.
 *  2. Rebuilds the state from scratch: re-reads every header and log from the start block to P,
 *     re-checks the hash links, and folds the events through the independent in-memory ReadModel.
 *     Every table (and a digest of every event, transfer and freeze action) must match.
 *  3. If `state` is given, reads the contracts' own view functions at block P (balanceOf of every
 *     holder, totalSupply, paused, trustee cap, frozen state, distributions, documents, recovery
 *     requests, identities) and compares them with the read model.
 * Nothing is written. A mismatch is reported (exit code 1 in the CLI); it does not halt the indexer.
 */
export async function verify(
  pool: pg.Pool,
  source: ChainSource,
  deployment: Deployment,
  opts: { state?: PublicClient | null; window?: number } = {},
): Promise<VerifyReport> {
  const started = performance.now();
  const problems: string[] = [];
  const d = deployment;

  const client = await pool.connect();
  let snapshot: Snapshot;
  let pinned: bigint;
  let pinnedHash: string | null;
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const { rows } = await client.query<{ block_number: string; block_hash: string | null; halt_reason: string | null }>(
      "SELECT block_number, block_hash, halt_reason FROM chain.cursors WHERE deployment = $1", [d.id]);
    const c = rows[0];
    if (!c) throw new Error(`deployment ${d.id} is not registered`);
    pinned = BigInt(c.block_number);
    pinnedHash = c.block_hash;
    if (c.halt_reason) problems.push(`indexer is halted: ${c.halt_reason}`);
    snapshot = await readSnapshot(client, d);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }

  let stateReads = 0;
  if (opts.state && pinned >= d.fromBlock) {
    try {
      stateReads = await compareState(opts.state, d, pinned, snapshot, problems);
    } catch (err) {
      problems.push(`could not read contract state at block ${pinned.toString()}: ${err instanceof Error ? err.message.split("\n")[0] ?? "" : String(err)}`);
    }
  }

  // Rebuild from scratch.
  const model = new ReadModel(d);
  const roles = rolesByAddress(d);
  const addresses = [...roles.keys()] as Address[];
  const step = BigInt(opts.window ?? MAX_WINDOW);
  let parent: string | null = null;
  if (d.fromBlock > 0n) parent = (await source.headers(d.fromBlock - 1n, d.fromBlock - 1n))[0]?.hash.toLowerCase() ?? null;
  rebuild: for (let from = d.fromBlock; from <= pinned; from += step) {
    const to = from + step - 1n < pinned ? from + step - 1n : pinned;
    const headers = await source.headers(from, to);
    const hashes = new Map<bigint, string>();
    for (const h of headers) {
      if (parent !== null && h.parentHash.toLowerCase() !== parent) {
        problems.push(`chain mismatch: block ${h.number.toString()} does not link to block ${(h.number - 1n).toString()}`);
        break rebuild;
      }
      parent = h.hash.toLowerCase();
      hashes.set(h.number, parent);
    }
    const logs = await source.logs(addresses, from, to);
    logs.sort((a, b) => (a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1));
    for (const l of logs) {
      if (hashes.get(l.blockNumber) !== l.blockHash.toLowerCase() || l.removed) {
        problems.push(`chain mismatch: log at block ${l.blockNumber.toString()} log ${String(l.logIndex)} is not on the verified chain`);
        break rebuild;
      }
      const role = roles.get(l.address.toLowerCase());
      if (!role) continue;
      const decoded = decodeLog(role, l.topics, l.data);
      try {
        model.apply({
          blockNumber: l.blockNumber, blockHash: l.blockHash.toLowerCase() as Hex, logIndex: l.logIndex, txHash: l.transactionHash.toLowerCase() as Hex,
          txIndex: l.transactionIndex, address: l.address.toLowerCase(), role, name: decoded.name, args: decoded.args,
          topics: l.topics.map((t) => t.toLowerCase() as Hex), data: l.data.toLowerCase() as Hex,
        });
      } catch (err) {
        problems.push(`chain events break an invariant: ${err instanceof Error ? err.message : String(err)}`);
        break rebuild;
      }
    }
  }
  if (pinned >= d.fromBlock && parent !== pinnedHash) problems.push(`cursor block ${pinned.toString()} is recorded as ${pinnedHash ?? "nothing"}, the chain has ${parent ?? "nothing"}`);
  problems.push(...diffSnapshots(model.snapshot(), snapshot));

  return {
    ok: problems.length === 0,
    deployment: d.id,
    pinnedBlock: pinned,
    events: snapshot.counts.events,
    holders: Object.values(snapshot.holdings).filter((b) => b !== "0").length,
    stateReads,
    problems,
    ms: Math.round(performance.now() - started),
  };
}

/** Compares the read model with the contracts' own view functions at one block. Returns the number of reads. */
async function compareState(client: PublicClient, d: Deployment, block: bigint, s: Snapshot, problems: string[]): Promise<number> {
  const c = d.contracts;
  let reads = 0;
  const at = { blockNumber: block } as const;
  const read = async <T>(p: Promise<T>): Promise<T> => {
    reads++;
    return p;
  };
  const expect = (what: string, chain: unknown, model: unknown): void => {
    if (String(chain) !== String(model)) problems.push(`${what}: chain ${String(chain)} vs read model ${String(model)}`);
  };

  const token = c.token;
  const [supply, paused] = await Promise.all([
    read(client.readContract({ address: token, abi: tokenAbi, functionName: "totalSupply", ...at })),
    read(client.readContract({ address: token, abi: tokenAbi, functionName: "paused", ...at })),
  ]);
  expect("token.totalSupply", supply, s.token.totalSupply);
  expect("token.paused", paused, s.token.paused);
  if (c.issuance) expect("token.trusteeCap", await read(client.readContract({ address: c.issuance, abi: issuanceGuardAbi, functionName: "trusteeCap", ...at })), s.token.trusteeCap);

  const holders = [...new Set([...Object.keys(s.holdings), ...Object.keys(s.freezes)])] as Address[];
  let sum = 0n;
  for (const chunk of chunks(holders, 100)) {
    const rows = await Promise.all(chunk.map(async (h) => Promise.all([
      read(client.readContract({ address: token, abi: tokenAbi, functionName: "balanceOf", args: [h], ...at })),
      read(client.readContract({ address: token, abi: tokenAbi, functionName: "isFrozen", args: [h], ...at })),
      read(client.readContract({ address: token, abi: tokenAbi, functionName: "getFrozenTokens", args: [h], ...at })),
    ])));
    chunk.forEach((h, i) => {
      const [balance, frozen, frozenTokens] = rows.at(i) ?? [0n, false, 0n];
      sum += balance;
      expect(`balanceOf(${h})`, balance, own(s.holdings, h) ?? "0");
      expect(`isFrozen(${h})`, frozen, own(s.freezes, h)?.addressFrozen ?? false);
      expect(`getFrozenTokens(${h})`, frozenTokens, own(s.freezes, h)?.frozenAmount ?? "0");
    });
  }
  // I-1: the holders the read model knows account for the whole supply, so no holder is missing.
  expect("sum of balances vs totalSupply", sum, supply);

  if (c.distributions) {
    const registry = c.distributions;
    const count = await read(client.readContract({ address: registry, abi: distributionRegistryAbi, functionName: "distributionCount", ...at }));
    expect("distributionCount", count, Object.keys(s.distributions).length);
    for (const [id, m] of Object.entries(s.distributions)) {
      const x = await read(client.readContract({ address: registry, abi: distributionRegistryAbi, functionName: "getDistribution", args: [BigInt(id)], ...at }));
      expect(`distribution ${id}.status`, DIST_STATUS[x.status] ?? x.status, m.status);
      expect(`distribution ${id}.merkleRoot`, x.merkleRoot.toLowerCase(), m.merkleRoot);
      expect(`distribution ${id}.totalPaisa`, x.totalPaisa, m.totalPaisa);
      expect(`distribution ${id}.statementHash`, x.statementHash.toLowerCase(), m.statementHash);
      expect(`distribution ${id}.token`, x.token.toLowerCase(), m.token);
      expect(`distribution ${id}.payoutBatchHash`, x.payoutBatchHash === `0x${"0".repeat(64)}` ? null : x.payoutBatchHash.toLowerCase(), m.payoutBatchHash);
    }
  }
  if (c.documents) {
    const registry = c.documents;
    const count = await read(client.readContract({ address: registry, abi: documentRegistryAbi, functionName: "documentCount", ...at }));
    expect("documentCount", count, Object.keys(s.documents).length);
    for (const [id, m] of Object.entries(s.documents)) {
      const x = await read(client.readContract({ address: registry, abi: documentRegistryAbi, functionName: "getDocument", args: [BigInt(id)], ...at }));
      expect(`document ${id}.sha256Hash`, x.sha256Hash.toLowerCase(), m.sha256Hash);
      expect(`document ${id}.uri`, x.uri, m.uri);
      expect(`document ${id}.supersededBy`, x.supersededBy === 0n ? null : x.supersededBy, m.supersededBy);
    }
  }
  if (c.recovery) {
    const guard = c.recovery;
    const count = await read(client.readContract({ address: guard, abi: recoveryGuardAbi, functionName: "requestCount", ...at }));
    expect("recovery requestCount", count, Object.keys(s.recoveries).length);
    for (const [id, m] of Object.entries(s.recoveries)) {
      const x = await read(client.readContract({ address: guard, abi: recoveryGuardAbi, functionName: "getRequest", args: [BigInt(id)], ...at }));
      expect(`recovery ${id}.status`, RECOVERY_STATUS[x.status] ?? x.status, m.status);
      expect(`recovery ${id}.from`, x.from.toLowerCase(), m.from);
      expect(`recovery ${id}.to`, x.to.toLowerCase(), m.to);
    }
  }
  if (c.identityRegistry) {
    const ir = c.identityRegistry;
    for (const chunk of chunks(Object.entries(s.investors), 100)) {
      const rows = await Promise.all(chunk.map(async ([w]) => Promise.all([
        read(client.readContract({ address: ir, abi: identityRegistryAbi, functionName: "identity", args: [w as Address], ...at })),
        read(client.readContract({ address: ir, abi: identityRegistryAbi, functionName: "investorCountry", args: [w as Address], ...at })),
      ])));
      chunk.forEach(([w, m], i) => {
        const [identity, country] = rows.at(i) ?? [ZERO, 0];
        const onChain = identity.toLowerCase();
        expect(`investor ${w}.registered`, onChain !== ZERO, m.registered);
        if (m.registered && !m.identityStale) expect(`investor ${w}.identity`, onChain, m.identity);
        if (m.registered && m.country !== null) expect(`investor ${w}.country`, country, m.country);
      });
    }
  }
  return reads;
}

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
