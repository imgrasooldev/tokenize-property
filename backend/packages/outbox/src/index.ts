import type pg from "pg";
import { z } from "zod";

/**
 * Outbox (Step 5c). Commands for the chain are written in the same transaction as the business
 * change (enqueue), then executed by workers. The database enforces the rules (migration
 * 0003_outbox.sql); this module adds typing, validation and the worker loop.
 *
 * Exactly-once on chain (ADR 0004): a transaction is recorded before it is broadcast and only by
 * the lease owner; after any failure the worker decides from the DATABASE state (nothing recorded
 * means nothing was sent) and from the CHAIN (mined, reverted, dropped), never from the error type.
 */

export type Hex = `0x${string}`;
export type CommandStatus = "pending" | "claimed" | "submitted" | "confirmed" | "failed" | "review";

export interface Command {
  id: bigint;
  idempotencyKey: string;
  kind: string;
  payload: Record<string, unknown>;
  ref: string | null;
  status: CommandStatus;
  attempts: number;
  maxAttempts: number;
  leaseOwner: string | null;
  tx: Signed | null;
  submittedAt: Date | null;
  lastError: string | null;
}

/** A signed transaction, known before it is broadcast. */
export interface Signed {
  hash: Hex;
  nonce: bigint;
  from: Hex;
}

export type Outcome = "success" | "reverted" | "dropped" | "pending" | "unknown";

/** Refused before anything was sent, and retrying cannot help (e.g. the contract would revert). */
export class RefusedError extends Error {
  override name = "RefusedError";
}

/** Nothing was sent; worth retrying later (e.g. node unreachable). */
export class TransientError extends Error {
  override name = "TransientError";
}

/**
 * Executes one kind of command on the chain. Contract:
 *  - `submit` signs the transaction, calls `record(signed)` and broadcasts ONLY if record returned
 *    true. It returns null if record returned false (lease lost: nothing may be sent).
 *  - Errors before `record` must leave nothing sent. Errors after it mean "outcome unknown".
 *  - `wait` and `outcome` only read the chain.
 */
export interface Executor {
  submit(command: Command, record: (signed: Signed) => Promise<boolean>): Promise<Signed | null>;
  wait(signed: Signed, timeoutMs: number): Promise<"success" | "reverted" | "pending">;
  outcome(signed: Signed): Promise<Outcome>;
}

export class OutboxError extends Error {
  constructor(
    readonly code: "IDEMPOTENCY_CONFLICT" | "INVALID",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "OutboxError";
  }
}

const enqueueSchema = z.object({
  idempotencyKey: z.string().min(8).max(200),
  kind: z
    .string()
    .max(64)
    .refine((k) => k.split(".").every((part) => /^[a-z][a-z0-9_]*$/.test(part)), "dotted lower-case name, e.g. issuance.mint"),
  payload: z.record(z.string(), z.unknown()),
  ref: z.string().max(200).optional(),
  createdBy: z.string().min(1).max(100),
  maxAttempts: z.number().int().min(1).max(20).optional(),
});

export type EnqueueInput = z.input<typeof enqueueSchema>;

/**
 * Adds a command. Call it with the SAME client/transaction as the business change, so both commit
 * or neither does. An identical retry returns the original id.
 */
export async function enqueue(db: pg.ClientBase | pg.Pool, input: EnqueueInput): Promise<bigint> {
  const parsed = enqueueSchema.safeParse(input);
  if (!parsed.success) throw new OutboxError("INVALID", parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  const c = parsed.data;
  try {
    const { rows } = await db.query<{ id: string }>("SELECT outbox.enqueue($1, $2, $3::jsonb, $4, $5, $6) AS id", [
      c.idempotencyKey,
      c.kind,
      JSON.stringify(c.payload),
      c.ref ?? null,
      c.createdBy,
      c.maxAttempts ?? 5,
    ]);
    return BigInt(rows[0]?.id ?? "0");
  } catch (err) {
    const msg = (err as { message?: string }).message ?? "";
    if (msg.includes("idempotency key")) throw new OutboxError("IDEMPOTENCY_CONFLICT", msg, { cause: err });
    if ((err as { code?: string }).code === "23514") throw new OutboxError("INVALID", msg, { cause: err });
    throw err;
  }
}

interface Row {
  id: string;
  idempotency_key: string;
  kind: string;
  payload: Record<string, unknown>;
  ref: string | null;
  status: CommandStatus;
  attempts: number;
  max_attempts: number;
  lease_owner: string | null;
  tx_hash: Hex | null;
  tx_nonce: string | null;
  tx_from: Hex | null;
  submitted_at: Date | null;
  last_error: string | null;
}

function toCommand(r: Row): Command {
  return {
    id: BigInt(r.id),
    idempotencyKey: r.idempotency_key,
    kind: r.kind,
    payload: r.payload,
    ref: r.ref,
    status: r.status,
    attempts: r.attempts,
    maxAttempts: r.max_attempts,
    leaseOwner: r.lease_owner,
    tx: r.tx_hash && r.tx_nonce !== null && r.tx_from ? { hash: r.tx_hash, nonce: BigInt(r.tx_nonce), from: r.tx_from } : null,
    submittedAt: r.submitted_at,
    lastError: r.last_error,
  };
}

export async function getCommand(db: pg.ClientBase | pg.Pool, id: bigint): Promise<Command | null> {
  const { rows } = await db.query<Row>("SELECT * FROM outbox.commands WHERE id = $1", [id.toString()]);
  return rows[0] ? toCommand(rows[0]) : null;
}

export interface QueueStats {
  status: CommandStatus;
  commands: number;
  oldestSeconds: number;
}

export async function stats(db: pg.ClientBase | pg.Pool): Promise<QueueStats[]> {
  const { rows } = await db.query<{ status: CommandStatus; commands: string; oldest_seconds: number }>("SELECT * FROM outbox.stats()");
  return rows.map((r) => ({ status: r.status, commands: Number(r.commands), oldestSeconds: r.oldest_seconds }));
}

// ------------------------------------------------------------------ worker

export interface WorkerOptions {
  /** Unique per worker process, e.g. "worker-1@host". */
  workerId: string;
  /** Executors by command kind. A kind without one fails (not retryable). */
  executors: Readonly<Record<string, Executor>>;
  batch?: number;
  leaseSeconds?: number;
  /** How long to wait for a receipt before leaving the command for later resolution. */
  waitMs?: number;
  /** Polling interval as a fallback to LISTEN/NOTIFY. */
  pollMs?: number;
  /** A submitted command whose transaction is still unknown after this long goes to review. */
  reviewAfterMs?: number;
  onError?: (context: string, err: unknown) => void;
}

export class OutboxWorker {
  private readonly batch: number;
  private readonly leaseSeconds: number;
  private readonly waitMs: number;
  private readonly pollMs: number;
  private readonly reviewAfterMs: number;
  private listener: pg.PoolClient | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<number> | null = null;
  private again = false;
  private stopped = true;

  constructor(
    private readonly pool: pg.Pool,
    private readonly opts: WorkerOptions,
  ) {
    if (!/^[\w.@:-]{1,100}$/.test(opts.workerId)) throw new OutboxError("INVALID", "workerId must be 1-100 safe characters");
    this.batch = opts.batch ?? 10;
    this.leaseSeconds = opts.leaseSeconds ?? 60;
    this.waitMs = opts.waitMs ?? 30_000;
    this.pollMs = opts.pollMs ?? 2_000;
    this.reviewAfterMs = opts.reviewAfterMs ?? 10 * 60_000;
  }

  /** Starts listening for new commands (LISTEN/NOTIFY) with polling as a fallback. */
  async start(): Promise<void> {
    this.stopped = false;
    this.listener = await this.pool.connect();
    this.listener.on("notification", () => {
      this.kick();
    });
    await this.listener.query("LISTEN outbox");
    this.timer = setInterval(() => {
      this.kick();
    }, this.pollMs);
    this.kick();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.listener) {
      await this.listener.query("UNLISTEN outbox").catch(() => undefined);
      this.listener.release();
      this.listener = null;
    }
    await this.running;
  }

  /** Runs a pass now, or right after the current one (never two at once in this process). */
  private kick(): void {
    if (this.stopped) return;
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = this.runOnce()
      .catch((e: unknown) => {
        this.opts.onError?.("runOnce", e);
        return 0;
      })
      .finally(() => {
        this.running = null;
        if (this.again) {
          this.again = false;
          this.kick();
        }
      });
  }

  /** Claims one batch and processes it. Returns how many commands were handled. */
  async runOnce(): Promise<number> {
    const { rows } = await this.pool.query<Row>("SELECT * FROM outbox.claim($1, $2, $3)", [
      this.opts.workerId,
      this.batch,
      this.leaseSeconds,
    ]);
    // Commands are independent; each one's chain work is serialised per signer by the executor.
    await Promise.all(rows.map((r) => this.process(toCommand(r)).catch((e: unknown) => this.opts.onError?.(`command ${r.id}`, e))));
    return rows.length;
  }

  private async process(cmd: Command): Promise<void> {
    const executor = Object.hasOwn(this.opts.executors, cmd.kind) ? this.opts.executors[cmd.kind] : undefined;
    if (cmd.status === "submitted") {
      if (!executor || !cmd.tx) {
        await this.resolve(cmd.id, "review", "submitted command cannot be checked (no executor)");
        return;
      }
      await this.settleSubmitted(cmd, executor, cmd.tx);
      return;
    }
    if (!executor) {
      await this.release(cmd.id, `no executor for kind ${cmd.kind}`, false);
      return;
    }

    let signed: Signed | null;
    try {
      signed = await executor.submit(cmd, async (s) => this.record(cmd.id, s));
    } catch (e) {
      // Decide from the database, not the error: if nothing was recorded, nothing was sent.
      const now = await getCommand(this.pool, cmd.id);
      if (now?.status === "claimed" && now.leaseOwner === this.opts.workerId) {
        await this.release(cmd.id, message(e), !(e instanceof RefusedError));
      } else {
        this.opts.onError?.(`command ${cmd.id.toString()} after submission`, e);
        // Submitted: the lease will expire and the chain will decide.
      }
      return;
    }
    if (!signed) return; // lease lost before recording: nothing was sent

    const result = await executor.wait(signed, this.waitMs).catch(() => "pending" as const);
    if (result === "success") await this.complete(cmd.id, signed);
    else if (result === "reverted") await this.resolve(cmd.id, "reverted", `transaction reverted (${signed.hash})`);
    // pending: leave it submitted; after the lease, a worker resolves it from the chain.
  }

  private async settleSubmitted(cmd: Command, executor: Executor, tx: Signed): Promise<void> {
    const outcome = await executor.outcome(tx).catch(() => "unknown" as const);
    switch (outcome) {
      case "success":
        await this.complete(cmd.id, tx);
        return;
      case "reverted":
        await this.resolve(cmd.id, "reverted", `transaction reverted (${tx.hash})`);
        return;
      case "dropped":
        await this.resolve(cmd.id, "dropped", `transaction dropped (${tx.hash}); nonce used by another transaction`);
        return;
      case "pending":
      case "unknown": {
        const age = cmd.submittedAt ? Date.now() - cmd.submittedAt.getTime() : Infinity;
        if (age > this.reviewAfterMs) await this.resolve(cmd.id, "review", `transaction ${tx.hash} still ${outcome} after ${String(Math.round(age / 1000))} s`);
        // Otherwise leave it; the lease expires and it is checked again.
        return;
      }
    }
  }

  private async record(id: bigint, s: Signed): Promise<boolean> {
    const { rows } = await this.pool.query<{ ok: boolean }>("SELECT outbox.record_submission($1, $2, $3, $4, $5) AS ok", [
      id.toString(),
      this.opts.workerId,
      s.hash,
      s.nonce.toString(),
      s.from,
    ]);
    return rows[0]?.ok === true;
  }

  private async complete(id: bigint, s: Signed): Promise<void> {
    await this.pool.query("SELECT outbox.complete($1, $2, $3::jsonb)", [id.toString(), this.opts.workerId, JSON.stringify({ txHash: s.hash })]);
  }

  private async release(id: bigint, error: string, retryable: boolean): Promise<void> {
    await this.pool.query("SELECT outbox.release($1, $2, $3, $4)", [id.toString(), this.opts.workerId, error, retryable]);
  }

  private async resolve(id: bigint, outcome: "reverted" | "dropped" | "review", detail: string): Promise<void> {
    await this.pool.query("SELECT outbox.resolve($1, $2, $3, $4)", [id.toString(), this.opts.workerId, outcome, detail]);
  }
}

function message(e: unknown): string {
  return (e instanceof Error ? `${e.name}: ${e.message}` : String(e)).replace(/\s+/g, " ").slice(0, 500);
}
