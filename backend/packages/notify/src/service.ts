import type pg from "pg";
import { z } from "zod";
import type { ContactChannel, ContactSecrets } from "./crypto.ts";
import { EventError, wireParams, type Channel, type Locale, type NotifyEvent } from "./events.ts";

/**
 * Producer and account-side API of the notifications service (ADR 0013). The database enforces the
 * rules (migration 0017_notify.sql, N-1..N-9); this module validates input and maps errors.
 */

export type NotifyErrorCode = "INVALID" | "IDEMPOTENCY_CONFLICT" | "NOT_FOUND";

export class NotifyError extends Error {
  constructor(
    readonly code: NotifyErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "NotifyError";
  }
}

type Db = pg.ClientBase | pg.Pool;

export interface RecipientRef {
  type: "investor" | "officer";
  /** Investor: KYC subject uuid. Officer: officer id. */
  id: string;
}

const recipientSchema = z.strictObject({
  type: z.enum(["investor", "officer"]),
  id: z.string().min(1).max(64),
});
const actorSchema = z.string().min(1).max(100);
const keySchema = z.string().min(8).max(200);

function mapDbError(err: unknown): never {
  const msg = (err as { message?: string }).message ?? "";
  const code = (err as { code?: string }).code;
  if (msg.includes("idempotency key")) throw new NotifyError("IDEMPOTENCY_CONFLICT", msg, { cause: err });
  if (code === "23503") throw new NotifyError("NOT_FOUND", msg, { cause: err });
  if (code === "23514" || code === "22P02") throw new NotifyError("INVALID", msg, { cause: err });
  throw err;
}

function invalid(e: z.ZodError): NotifyError {
  return new NotifyError("INVALID", e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
}

export interface EnqueueInput {
  /** Unique per business event and recipient, e.g. "bank:payee-changed:<payeeId>". */
  key: string;
  event: NotifyEvent;
  recipient: RecipientRef;
  /** Who raised it, e.g. "bank-service" or "system:cooling-off". */
  actor: string;
}

/**
 * N-4: call with the SAME client/transaction as the business change, so both commit or neither
 * does. An identical retry returns the original id; a different event under the key is refused.
 */
export async function enqueue(db: Db, input: EnqueueInput): Promise<bigint> {
  const key = keySchema.safeParse(input.key);
  if (!key.success) throw invalid(key.error);
  const recipient = recipientSchema.safeParse(input.recipient);
  if (!recipient.success) throw invalid(recipient.error);
  const actor = actorSchema.safeParse(input.actor);
  if (!actor.success) throw invalid(actor.error);
  let params: Record<string, string>;
  try {
    params = wireParams(input.event.kind, input.event.params);
  } catch (e) {
    if (e instanceof EventError) throw new NotifyError("INVALID", e.message, { cause: e });
    throw e;
  }
  try {
    const { rows } = await db.query<{ id: string }>("SELECT notify.enqueue($1, $2, $3, $4, $5::jsonb, $6) AS id", [
      key.data,
      input.event.kind,
      recipient.data.type,
      recipient.data.id,
      JSON.stringify(params),
      actor.data,
    ]);
    return BigInt(rows[0]?.id ?? "0");
  } catch (err) {
    mapDbError(err);
  }
}

/** Recipients, contacts and preferences: called by the account-facing service (website, app). */
export class NotifyService {
  constructor(
    private readonly db: Db,
    private readonly secrets: ContactSecrets,
  ) {}

  async registerRecipient(recipient: RecipientRef, locale: Locale, actor: string): Promise<string> {
    const r = recipientSchema.parse(recipient);
    try {
      const { rows } = await this.db.query<{ id: string }>("SELECT notify.register_recipient($1, $2, $3, $4) AS id", [
        r.type,
        r.id,
        locale,
        actorSchema.parse(actor),
      ]);
      return rows[0]?.id ?? "";
    } catch (err) {
      mapDbError(err);
    }
  }

  /**
   * Registers or replaces a phone number or e-mail address. The caller must have proved ownership
   * (one-time code to that contact) first. A replacement alerts the old contact too (N-4).
   */
  async registerContact(recipientId: string, channel: ContactChannel, value: string, actor: string): Promise<bigint> {
    const p = this.secrets.protect(z.uuid().parse(recipientId), channel, value);
    try {
      const { rows } = await this.db.query<{ id: string }>("SELECT notify.register_contact($1, $2, $3, $4, $5::smallint, $6) AS id", [
        recipientId,
        channel,
        p.lookupHash,
        p.sealed,
        p.keyVersion,
        actorSchema.parse(actor),
      ]);
      return BigInt(rows[0]?.id ?? "0");
    } catch (err) {
      mapDbError(err);
    }
  }

  /** Transactional notices only; security notices cannot be switched off (N-3). */
  async setPreference(recipientId: string, channel: Channel, enabled: boolean, actor: string): Promise<void> {
    try {
      await this.db.query("SELECT notify.set_preference($1, $2, $3, $4)", [z.uuid().parse(recipientId), channel, enabled, actorSchema.parse(actor)]);
    } catch (err) {
      mapDbError(err);
    }
  }

  /**
   * NP-5 (migration 0030): marketing needs an explicit opt-in per channel, recorded with the version
   * of the consent text the investor saw. Opting out is the same call with granted = false.
   */
  async setMarketingConsent(recipientId: string, channel: ContactChannel, granted: boolean, textVersion: string, actor: string): Promise<void> {
    try {
      await this.db.query("SELECT notify.set_marketing_consent($1, $2, $3, $4, $5)", [
        z.uuid().parse(recipientId),
        channel,
        granted,
        z
          .string()
          .regex(/^[a-z][a-z0-9.-]{2,31}$/)
          .parse(textVersion),
        actorSchema.parse(actor),
      ]);
    } catch (err) {
      mapDbError(err);
    }
  }

  async setLocale(recipientId: string, locale: Locale, actor: string): Promise<void> {
    try {
      await this.db.query("SELECT notify.set_locale($1, $2, $3)", [z.uuid().parse(recipientId), locale, actorSchema.parse(actor)]);
    } catch (err) {
      mapDbError(err);
    }
  }
}

// ------------------------------------------------------------------ operations

export interface QueueStat {
  status: string;
  count: number;
  oldestSeconds: number;
}

export async function stats(db: Db): Promise<QueueStat[]> {
  const { rows } = await db.query<{ status: string; deliveries: string; oldest_seconds: number | null }>("SELECT * FROM notify.stats() ORDER BY 1");
  return rows.map((r) => ({ status: r.status, count: Number(r.deliveries), oldestSeconds: Math.round(r.oldest_seconds ?? 0) }));
}

export interface DeadLetter {
  id: bigint;
  kind: string;
  category: string;
  channel: string;
  recipientId: string;
  attempts: number;
  lastError: string | null;
  updatedAt: Date;
}

/** Dead letters for the operator (no contact details, no message text). */
export async function deadLetters(db: Db, limit = 50): Promise<DeadLetter[]> {
  const { rows } = await db.query<{
    id: string;
    kind: string;
    category: string;
    channel: string;
    recipient_id: string;
    attempts: number;
    last_error: string | null;
    updated_at: Date;
  }>("SELECT id, kind, category, channel, recipient_id, attempts, last_error, updated_at FROM notify.delivery_status WHERE status = 'dead' ORDER BY id LIMIT $1", [limit]);
  return rows.map((r) => ({
    id: BigInt(r.id),
    kind: r.kind,
    category: r.category,
    channel: r.channel,
    recipientId: r.recipient_id,
    attempts: r.attempts,
    lastError: r.last_error,
    updatedAt: r.updated_at,
  }));
}

/** Security notices that found no contact at all (N-3): someone must reach the investor. */
export async function undeliverable(db: Db, limit = 50): Promise<{ id: bigint; kind: string; subjectType: string; subjectId: string; createdAt: Date }[]> {
  const { rows } = await db.query<{ id: string; kind: string; subject_type: string; subject_id: string; created_at: Date }>(
    "SELECT id, kind, subject_type, subject_id, created_at FROM notify.notification_status WHERE status = 'undeliverable' ORDER BY id LIMIT $1",
    [limit],
  );
  return rows.map((r) => ({ id: BigInt(r.id), kind: r.kind, subjectType: r.subject_type, subjectId: r.subject_id, createdAt: r.created_at }));
}

export async function operatorDecide(db: Db, deliveryId: bigint, operator: string, decision: "retry" | "abandon", reason: string): Promise<boolean> {
  try {
    const { rows } = await db.query<{ ok: boolean }>("SELECT notify.operator_decide($1, $2, $3, $4) AS ok", [deliveryId.toString(), operator, decision, reason]);
    return rows[0]?.ok === true;
  } catch (err) {
    mapDbError(err);
  }
}

export interface SweepResult {
  reservationExpiring: number;
  payoutAccountActive: number;
  kycExpired: number;
  slaBreaches: number;
}

/**
 * Time-based reminders (migration 0030 notify.sweep): reservations expiring within 2 hours, payout
 * accounts out of the cooling-off, expired KYC verifications, compliance items past their service
 * level. Idempotent per key, so it may run as often as wanted (the worker runs it every minute).
 */
export async function sweep(db: Db, actor = "notify:sweep"): Promise<SweepResult> {
  const { rows } = await db.query<{ r: SweepResult }>("SELECT notify.sweep($1) AS r", [actorSchema.parse(actor)]);
  return rows[0]?.r ?? { reservationExpiring: 0, payoutAccountActive: 0, kycExpired: 0, slaBreaches: 0 };
}

/** NP-3: notifications a producer could not raise (the business change committed without them). */
export async function producerFailures(db: Db, limit = 50): Promise<{ id: bigint; kind: string; key: string; sqlstate: string; error: string; at: Date }[]> {
  const { rows } = await db.query<{ id: string; kind: string; idempotency_key: string; sqlstate: string; error: string; at: Date }>(
    "SELECT id, kind, idempotency_key, sqlstate, error, at FROM notify.producer_failures ORDER BY id DESC LIMIT $1",
    [limit],
  );
  return rows.map((r) => ({ id: BigInt(r.id), kind: r.kind, key: r.idempotency_key, sqlstate: r.sqlstate, error: r.error, at: r.at }));
}

export async function verifyAudit(db: Db): Promise<{ auditId: bigint | null; problem: string }[]> {
  const { rows } = await db.query<{ audit_id: string | null; problem: string }>("SELECT * FROM notify.verify_audit()");
  return rows.map((r) => ({ auditId: r.audit_id === null ? null : BigInt(r.audit_id), problem: r.problem }));
}
