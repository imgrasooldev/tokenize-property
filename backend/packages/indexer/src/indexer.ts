import type pg from "pg";
import { decodeLog } from "./decode.ts";
import { rolesByAddress, type Address, type Deployment, type Hex, type Role } from "./deployment.ts";
import type { ChainSource, Header, RawLog } from "./source.ts";

/**
 * Indexer (Step 5e, ADR 0006): follows the chain and keeps the read model in schema `chain`.
 *
 * Each batch reads a window of blocks, checks that every header links to the one before (and the
 * first to the cursor), checks that every log belongs to those exact blocks, decodes the logs and
 * hands everything to chain.apply_batch in ONE transaction. The cursor moves by compare-and-set in
 * the database, so a batch is applied exactly once whatever crashes or retries happen.
 *
 * QBFT has immediate finality: a block, once seen, never changes. Any hash or parent mismatch
 * therefore means the node serves a different chain (a reset network, a wrong node, corruption).
 * The indexer HALTS on it and never guesses.
 */

/** Besu refuses eth_getLogs over more than 5,000 blocks; stay well inside. */
export const MAX_WINDOW = 4_000;

/** The chain no longer matches what was indexed. The deployment is halted. */
export class ChainMismatchError extends Error {
  override name = "ChainMismatchError";
}

/** A batch broke a contract invariant (gap, duplicate, impossible transition). The deployment is halted. */
export class InvariantViolationError extends Error {
  override name = "InvariantViolationError";
}

/** The deployment was halted earlier; an operator must investigate before it runs again. */
export class HaltedError extends Error {
  override name = "HaltedError";
}

export interface Cursor {
  blockNumber: bigint;
  blockHash: Hex | null;
  batches: number;
  events: number;
  haltedAt: Date | null;
  haltReason: string | null;
}

export interface BatchResult {
  from: bigint;
  to: bigint;
  events: number;
  /** Blocks still behind the head after this batch. */
  behind: bigint;
}

export interface IndexerOptions {
  /** Blocks per batch, at most MAX_WINDOW. */
  windowBlocks?: number;
  /** A window with more logs than this is split, to keep transactions short. */
  maxEventsPerBatch?: number;
  /** Follow mode: how often to look for new blocks. */
  pollMs?: number;
  /** Recorded as the actor of a halt. */
  actor?: string;
  onBatch?: (r: BatchResult) => void;
  onError?: (err: unknown) => void;
  /** Called once when the indexer halts (alerting). */
  onHalt?: (err: Error) => void;
  /** Fault injection for tests: runs inside the batch transaction, after apply_batch, before COMMIT. */
  beforeCommit?: () => Promise<void>;
  /** Fault injection for tests: runs after COMMIT, before the result is returned. */
  afterCommit?: () => Promise<void>;
}

interface BatchEvent {
  blockNumber: string;
  blockHash: Hex;
  logIndex: number;
  txHash: Hex;
  txIndex: number;
  address: string;
  name: string | null;
  args: unknown;
  topics: Hex[];
  data: Hex;
}

export class Indexer {
  private readonly window: bigint;
  private readonly maxEvents: number;
  private readonly roles: Map<string, Role>;
  private readonly addresses: Address[];
  private chainChecked = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private loop: Promise<void> | null = null;
  private stopped = true;
  private lockClient: pg.PoolClient | null = null;

  constructor(
    private readonly pool: pg.Pool,
    private readonly source: ChainSource,
    readonly deployment: Deployment,
    private readonly opts: IndexerOptions = {},
  ) {
    const w = opts.windowBlocks ?? MAX_WINDOW;
    if (!Number.isInteger(w) || w < 1 || w > MAX_WINDOW) throw new Error(`windowBlocks must be 1..${String(MAX_WINDOW)}`);
    this.window = BigInt(w);
    this.maxEvents = opts.maxEventsPerBatch ?? 5_000;
    this.roles = rolesByAddress(deployment);
    this.addresses = [...this.roles.keys()] as Address[];
  }

  /** Registers the deployment (idempotent) and checks that the node serves the expected chain. */
  async register(): Promise<void> {
    await this.checkChain();
    const d = this.deployment;
    const start = d.fromBlock > 0n ? (await this.source.headers(d.fromBlock - 1n, d.fromBlock - 1n))[0]?.hash ?? null : null;
    await this.pool.query("SELECT chain.register_deployment($1, $2, $3, $4::jsonb, $5)", [
      d.id,
      d.chainId,
      d.fromBlock.toString(),
      JSON.stringify(d.contracts),
      start,
    ]);
  }

  async cursor(): Promise<Cursor> {
    const { rows } = await this.pool.query<{
      block_number: string; block_hash: Hex | null; batches: string; events: string; halted_at: Date | null; halt_reason: string | null;
    }>("SELECT block_number, block_hash, batches, events, halted_at, halt_reason FROM chain.cursors WHERE deployment = $1", [this.deployment.id]);
    const r = rows[0];
    if (!r) throw new Error(`deployment ${this.deployment.id} is not registered; call register() first`);
    return {
      blockNumber: BigInt(r.block_number), blockHash: r.block_hash, batches: Number(r.batches), events: Number(r.events),
      haltedAt: r.halted_at, haltReason: r.halt_reason,
    };
  }

  /**
   * Applies at most one batch. Returns null when there is nothing new (or when another indexer
   * applied the same batch first). Throws ChainMismatchError / InvariantViolationError after
   * halting, HaltedError when already halted, and any other error for transient failures (nothing
   * was committed; simply call again).
   */
  async runOnce(): Promise<BatchResult | null> {
    await this.checkChain();
    const c = await this.cursor();
    if (c.haltedAt) throw new HaltedError(`deployment ${this.deployment.id} is halted: ${c.haltReason ?? ""}`);
    const head = await this.source.head();
    const from = c.blockNumber + 1n;
    if (head < from) {
      await this.checkTip(c);
      return null;
    }
    let to = head - from + 1n > this.window ? from + this.window - 1n : head;

    // Independent reads, in parallel; the logs are trusted only after they match the checked headers.
    const [headers, allLogs] = await Promise.all([this.source.headers(from, to), this.source.logs(this.addresses, from, to)]);
    await this.checkHeaders(c, from, to, headers);

    let logs = allLogs;
    while (logs.length > this.maxEvents && to > from) {
      to = from + (to - from) / 2n;
      logs = logs.filter((l) => l.blockNumber <= to);
    }
    const used = headers.slice(0, Number(to - from) + 1);
    const events = await this.checkLogs(used, logs);

    // Blocks recorded: first, last and every block with an event (C-2 links batches through them).
    const keep = new Set<bigint>([from, to, ...events.map((e) => BigInt(e.blockNumber))]);
    const blocks = used
      .filter((h) => keep.has(h.number))
      .map((h) => ({ number: h.number.toString(), hash: h.hash.toLowerCase(), parentHash: h.parentHash.toLowerCase(), timestamp: h.timestamp.toString() }));
    const last = used.at(-1);
    if (!last) throw new Error("empty window");

    const client = await this.pool.connect();
    let applied: number;
    try {
      await client.query("BEGIN");
      // A full 4,000-block window with thousands of events takes well under a second; allow headroom.
      await client.query("SET LOCAL statement_timeout = '120s'");
      const { rows } = await client.query<{ n: number }>("SELECT chain.apply_batch($1, $2, $3, $4, $5::jsonb, $6::jsonb) AS n", [
        this.deployment.id,
        c.blockNumber.toString(),
        to.toString(),
        last.hash.toLowerCase(),
        JSON.stringify(blocks),
        JSON.stringify(events),
      ]);
      applied = rows[0]?.n ?? 0;
      await this.opts.beforeCommit?.();
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
      return this.onBatchError(err);
    }
    client.release();
    await this.opts.afterCommit?.();
    const result: BatchResult = { from, to, events: applied, behind: head - to };
    this.opts.onBatch?.(result);
    return result;
  }

  /** Runs batches until the head is reached. */
  async catchUp(): Promise<{ batches: number; events: number; blocks: bigint }> {
    let batches = 0;
    let events = 0;
    let blocks = 0n;
    for (;;) {
      const r = await this.runOnce();
      if (!r) return { batches, events, blocks };
      batches++;
      events += r.events;
      blocks += r.to - r.from + 1n;
      if (r.behind === 0n) return { batches, events, blocks };
    }
  }

  /**
   * Follow mode: one indexer per deployment (a session advisory lock refuses a second one; the
   * cursor compare-and-set would also make it harmless). Transient errors back off up to 30 s.
   * A halt stops the loop and calls onHalt.
   */
  async start(): Promise<void> {
    if (!this.stopped) return;
    const lock = await this.pool.connect();
    const { rows } = await lock.query<{ ok: boolean }>("SELECT pg_try_advisory_lock(586586050, hashtext($1)) AS ok", [this.deployment.id]);
    if (!rows[0]?.ok) {
      lock.release();
      throw new Error(`another indexer is already following ${this.deployment.id}`);
    }
    this.lockClient = lock;
    try {
      await this.register();
    } catch (err) {
      await this.stop();
      throw err;
    }
    this.stopped = false;
    let failures = 0;
    const tick = async (): Promise<void> => {
      let delay = this.opts.pollMs ?? 1_000;
      try {
        const r = await this.runOnce();
        failures = 0;
        if (r && r.behind > 0n) delay = 0;
      } catch (err) {
        if (err instanceof ChainMismatchError || err instanceof InvariantViolationError || err instanceof HaltedError) {
          this.stopped = true;
          this.opts.onHalt?.(err);
          return;
        }
        this.opts.onError?.(err);
        failures++;
        delay = Math.min(30_000, 500 * 2 ** Math.min(failures, 6));
      }
      if (this.stopped) return;
      this.timer = setTimeout(() => {
        this.loop = tick();
      }, delay);
    };
    this.loop = tick();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.loop;
    if (this.lockClient) {
      await this.lockClient.query("SELECT pg_advisory_unlock(586586050, hashtext($1))", [this.deployment.id]).catch(() => undefined);
      this.lockClient.release();
      this.lockClient = null;
    }
  }

  /** True while follow mode runs (false after stop() or a halt). */
  get running(): boolean {
    return !this.stopped;
  }

  // ---------------------------------------------------------------- checks

  private async checkChain(): Promise<void> {
    if (this.chainChecked) return;
    const id = await this.source.chainId();
    if (id !== this.deployment.chainId) {
      throw new ChainMismatchError(`node serves chain ${String(id)}, deployment ${this.deployment.id} is on chain ${String(this.deployment.chainId)}`);
    }
    this.chainChecked = true;
  }

  /** At the head: the cursor block must still be the block the node has at that height. */
  private async checkTip(c: Cursor): Promise<void> {
    if (c.blockNumber < 0n || !c.blockHash) return;
    const [h] = await this.source.headers(c.blockNumber, c.blockNumber);
    if (h?.hash.toLowerCase() !== c.blockHash) {
      await this.halt(new ChainMismatchError(`block ${c.blockNumber.toString()} was indexed as ${c.blockHash}, the node now has ${h?.hash ?? "nothing"}`));
    }
  }

  private async checkHeaders(c: Cursor, from: bigint, to: bigint, headers: Header[]): Promise<void> {
    if (headers.length !== Number(to - from + 1n)) throw new Error(`node returned ${String(headers.length)} headers for ${String(to - from + 1n)} blocks`);
    let parent = c.blockHash;
    let expected = from;
    for (const h of headers) {
      if (h.number !== expected) throw new Error(`node returned block ${h.number.toString()} where ${expected.toString()} was expected`);
      if (parent !== null && h.parentHash.toLowerCase() !== parent) {
        await this.halt(new ChainMismatchError(`block ${h.number.toString()} names parent ${h.parentHash}, but block ${(h.number - 1n).toString()} is ${parent}`));
      }
      parent = h.hash.toLowerCase() as Hex;
      expected++;
    }
  }

  private async checkLogs(headers: Header[], logs: RawLog[]): Promise<BatchEvent[]> {
    const byNumber = new Map(headers.map((h) => [h.number, h.hash.toLowerCase()]));
    const seen = new Set<string>();
    const sorted = [...logs].sort((a, b) => (a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1));
    const out: BatchEvent[] = [];
    for (const l of sorted) {
      const where = `block ${l.blockNumber.toString()} log ${String(l.logIndex)}`;
      const hash = byNumber.get(l.blockNumber);
      if (l.removed || hash === undefined || l.blockHash.toLowerCase() !== hash) {
        await this.halt(new ChainMismatchError(`log at ${where} has block hash ${l.blockHash}${l.removed ? " (removed)" : ""}, header is ${hash ?? "outside the window"}`));
      }
      const key = `${l.blockNumber.toString()}:${String(l.logIndex)}`;
      if (seen.has(key)) throw new Error(`node returned the log at ${where} twice`);
      seen.add(key);
      const role = this.roles.get(l.address.toLowerCase());
      if (!role) throw new Error(`node returned a log from ${l.address}, which was not asked for`);
      const decoded = decodeLog(role, l.topics, l.data);
      out.push({
        blockNumber: l.blockNumber.toString(),
        blockHash: l.blockHash.toLowerCase() as Hex,
        logIndex: l.logIndex,
        txHash: l.transactionHash.toLowerCase() as Hex,
        txIndex: l.transactionIndex,
        address: l.address.toLowerCase(),
        name: decoded.name,
        args: decoded.args,
        topics: l.topics.map((t) => t.toLowerCase() as Hex),
        data: l.data.toLowerCase() as Hex,
      });
    }
    return out;
  }

  /** Records the halt in its own transaction, tells onHalt, and throws. */
  private async halt(err: ChainMismatchError | InvariantViolationError): Promise<never> {
    await this.pool.query("SELECT chain.halt($1, $2, $3)", [this.deployment.id, this.opts.actor ?? "indexer", `${err.name}: ${err.message}`]);
    throw err;
  }

  private async onBatchError(err: unknown): Promise<null> {
    const code = (err as { code?: string }).code;
    const message = err instanceof Error ? err.message : String(err);
    if (code === "PTC01") return null; // another batch moved the cursor first; nothing to undo
    if (code === "PTC04") throw new HaltedError(message);
    if (code === "PTC02") return this.halt(new ChainMismatchError(message));
    // Deterministic data problems would fail the same way on every retry: halt, never loop.
    if (code === "PTC03" || code?.startsWith("23") || code?.startsWith("22")) return this.halt(new InvariantViolationError(message));
    throw err;
  }
}
