import { randomUUID } from "node:crypto";
import type { BankGateway } from "@pt/bank";
import type pg from "pg";
import { keccak256, stringToBytes, type Hex } from "viem";
import { z } from "zod";

/**
 * Offering lifecycle (spec S-02, migration 0015).
 *
 * The database decides: every state change, guard, duty, maker-checker rule, unit count, payment
 * match, mint command and refund lives in the offering.* SQL functions. This module validates input
 * at the boundary (zod), derives each subscription's refId, maps SQL errors to typed errors and, for
 * refunds, instructs the bank only after the refund was recorded (record before send). Actor ids come
 * from the authenticated portal session (Step 6/7); the CLI is for operators until then.
 */

/**
 * The refId of a subscription: keccak256("property-token:subscription:<id>"), the derivation
 * reconciliation (@pt/recon refIdForSubscription) and the web prototype use (a test keeps them equal).
 */
export function refIdFor(subscriptionId: string): Hex {
  return keccak256(stringToBytes(`property-token:subscription:${subscriptionId}`));
}

export type OfferingErrorCode = "INVALID_INPUT" | "FORBIDDEN" | "GUARD" | "DUPLICATE" | "NOT_FOUND";

export class OfferingError extends Error {
  constructor(
    readonly code: OfferingErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "OfferingError";
  }
}

type Db = pg.Pool | pg.ClientBase;

/** Maps the SQLSTATEs the offering.* functions raise (see offering.fail) to error codes. */
export function mapError(e: unknown): unknown {
  const err = e as { code?: string; message?: string };
  const code = err.code ?? "";
  const msg = err.message ?? "database error";
  if (code === "42501") return new OfferingError("FORBIDDEN", msg);
  if (code === "23514") return new OfferingError("GUARD", msg);
  if (code === "23505") return new OfferingError("DUPLICATE", msg);
  if (code === "P0002" || code === "02000") return new OfferingError("NOT_FOUND", msg);
  if (code.startsWith("22") || code === "23503" || code === "23502") return new OfferingError("INVALID_INPUT", msg);
  return e;
}

// ------------------------------------------------------------------ schemas
const actor = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9@._:+-]{1,99}$/, "actor id: 2-100 characters");
const uuid = z.uuid();
const reason = z.string().trim().min(10).max(500);
const id = z.union([z.number().int().positive(), z.bigint().positive(), z.string().regex(/^[1-9][0-9]{0,18}$/)]).transform((v) => String(v));
const sha = z.string().regex(/^[0-9a-f]{64}$/, "SHA-256 as 64 lower-case hex characters");
const count = z.union([z.bigint().positive(), z.number().int().positive(), z.string().regex(/^[1-9][0-9]{0,12}$/)]).transform((v) => String(v));
const paisaText = z.union([z.bigint().nonnegative(), z.string().regex(/^[0-9]{1,15}$/)]).transform((v) => String(v));
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);

/** Offering terms (OF-1..OF-6, OF-10). Amounts and units as strings or bigints (never floats). */
export const termsSchema = z.strictObject({
  pricePaisa: count.optional(),
  minRaiseUnits: count.optional(),
  targetUnits: count.optional(),
  hardCapUnits: count.optional(),
  minUnits: count.optional(),
  maxUnits: count.optional(),
  opensAt: z.iso.datetime({ offset: true }).optional(),
  closesAt: z.iso.datetime({ offset: true }).optional(),
  paymentGraceMinutes: z.number().int().min(0).max(1440).optional(),
  reservationMinutes: z.number().int().min(60).max(4320).optional(),
  completionDays: z.number().int().min(1).max(365).optional(),
  earlyClose: z.boolean().optional(),
  categories: z.array(z.enum(["retail", "sophisticated"])).min(1).max(2).optional(),
  useOfProceeds: z.array(z.strictObject({ line: z.string().regex(/^[a-z][a-z0-9_]{2,40}$/), paisa: paisaText })).min(1).max(20).optional(),
  docEnSha: sha.optional(),
  docUrSha: sha.optional(),
  riskSha: sha.optional(),
});
export type Terms = z.input<typeof termsSchema>;

/** Request kinds an officer can open (L11, L12, L15 and V20 are opened by the system). */
const officerCode = z.enum(["L7", "L8", "L10", "L13", "L14", "L16", "CMP", "SD", "V17"]);
const anyCode = z.enum(["L3", "L7", "L8", "L10", "L11", "L12", "L13", "L14", "L15", "L16", "IB", "CMP", "SD", "V17", "V20"]);

interface Action<S extends z.ZodType, R> {
  schema: S;
  sql: string;
  params: (i: z.output<S>) => unknown[];
  result: (v: unknown) => R;
}

const act = <S extends z.ZodType, R>(schema: S, sql: string, params: (i: z.output<S>) => unknown[], result: (v: unknown) => R): Action<S, R> => ({
  schema,
  sql,
  params,
  result,
});
const asBig = (v: unknown): bigint => BigInt(String(v));
const asText = (v: unknown): string => String(v);
const asInt = (v: unknown): number => Number(v);
const asView = (v: unknown): SubscriptionView => v as SubscriptionView;
const asRecord = (v: unknown): Record<string, unknown> => v as Record<string, unknown>;
const asSettle = (v: unknown): { settled: number; review: number } => v as { settled: number; review: number };

/** What the investor sees of a subscription (no internal reasons: tipping-off). */
export interface SubscriptionView {
  subscriptionId: string;
  refId: string;
  state: string;
  units: string;
  amountPaisa: string;
  paymentCode: string | null;
  expiresAt: string | null;
  reason: string | null;
}

/**
 * Every operation of the S-02 workflow, as (input schema, SQL call). The service, the CLI and the
 * portals all go through runAction, so validation is the same everywhere.
 */
export const ACTIONS = {
  // ---- duties (pt_offering_admin)
  requestDuty: act(
    z.strictObject({ actor, duty: z.enum(["offering", "compliance", "legal_head", "trustee", "bank_operator"]), by: actor, reason }),
    "SELECT offering.request_duty($1, $2, $3, $4) AS r",
    (i) => [i.actor, i.duty, i.by, i.reason],
    asBig,
  ),
  decideDuty: act(
    z.strictObject({ dutyId: id, by: actor, approve: z.boolean(), reason }),
    "SELECT offering.decide_duty($1, $2, $3, $4) AS r",
    (i) => [i.dutyId, i.by, i.approve, i.reason],
    asText,
  ),
  revokeDuty: act(z.strictObject({ dutyId: id, by: actor, reason }), "SELECT offering.revoke_duty($1, $2, $3) AS r", (i) => [i.dutyId, i.by, i.reason], (v) => v === true),

  // ---- terms and approval (pt_offering_officer)
  createOffering: act(
    z.strictObject({ propertyId: uuid, actor, previousId: uuid.nullable().optional(), terms: termsSchema.optional() }),
    "SELECT offering.create_offering($1, $2, $3, $4::jsonb) AS r",
    (i) => [i.propertyId, i.actor, i.previousId ?? null, JSON.stringify(i.terms ?? {})],
    asText,
  ),
  updateTerms: act(
    z.strictObject({ offeringId: uuid, actor, terms: termsSchema }),
    "SELECT offering.update_terms($1, $2, $3::jsonb) AS r",
    (i) => [i.offeringId, i.actor, JSON.stringify(i.terms)],
    () => true,
  ),
  submit: act(z.strictObject({ offeringId: uuid, actor, reason }), "SELECT offering.submit($1, $2, $3) AS r", (i) => [i.offeringId, i.actor, i.reason], asBig),
  returnOffering: act(
    z.strictObject({ offeringId: uuid, actor, reason }),
    "SELECT offering.return_offering($1, $2, $3) AS r",
    (i) => [i.offeringId, i.actor, i.reason],
    asText,
  ),
  markReady: act(
    z.strictObject({ offeringId: uuid, token: address, actor }),
    "SELECT offering.mark_ready($1, $2, $3) AS r",
    (i) => [i.offeringId, i.token.toLowerCase(), i.actor],
    asText,
  ),
  suspend: act(z.strictObject({ offeringId: uuid, actor, reason }), "SELECT offering.suspend($1, $2, $3) AS r", (i) => [i.offeringId, i.actor, i.reason], asInt),
  request: act(
    z.strictObject({ offeringId: uuid, code: officerCode, actor, reason, detail: z.record(z.string(), z.unknown()).optional(), subscriptionId: uuid.optional() }),
    "SELECT offering.request($1, $2, $3, $4, $5::jsonb, $6) AS r",
    (i) => [i.offeringId, i.code, i.actor, i.reason, JSON.stringify(i.detail ?? {}), i.subscriptionId ?? null],
    asBig,
  ),
  decide: act(
    z.strictObject({ requestId: id, officer: actor, approve: z.boolean(), reason }),
    "SELECT offering.decide($1, $2, $3, $4) AS r",
    (i) => [i.requestId, i.officer, i.approve, i.reason],
    asText,
  ),
  decideAll: act(
    z.strictObject({ offeringId: uuid, code: anyCode, officer: actor, approve: z.boolean(), reason }),
    "SELECT offering.decide_all($1, $2, $3, $4, $5) AS r",
    (i) => [i.offeringId, i.code, i.officer, i.approve, i.reason],
    asInt,
  ),
  prepareBatch: act(
    z.strictObject({ offeringId: uuid, actor, reason }),
    "SELECT offering.prepare_batch($1, $2, $3) AS r",
    (i) => [i.offeringId, i.actor, i.reason],
    asBig,
  ),
  block: act(z.strictObject({ subscriptionId: uuid, officer: actor, reason }), "SELECT offering.block($1, $2, $3) AS r", (i) => [i.subscriptionId, i.officer, i.reason], asText),
  dispute: act(z.strictObject({ subscriptionId: uuid, officer: actor, reason }), "SELECT offering.dispute($1, $2, $3) AS r", (i) => [i.subscriptionId, i.officer, i.reason], asText),
  refundSubscription: act(
    z.strictObject({ subscriptionId: uuid, officer: actor, reason }),
    "SELECT offering.refund_subscription($1, $2, $3) AS r",
    (i) => [i.subscriptionId, i.officer, i.reason],
    asBig,
  ),

  // ---- investors (pt_offering_service; actor = the portal's authenticated investor)
  acceptDocument: act(
    z.strictObject({
      offeringId: uuid,
      subjectId: uuid,
      kind: z.enum(["offering_document", "risk_disclosure"]),
      language: z.enum(["en", "ur"]),
      sha256: sha,
      sessionHash: sha,
      deviceHash: sha,
      actor,
    }),
    "SELECT offering.accept_document($1, $2, $3, $4, $5, $6, $7, $8) AS r",
    (i) => [i.offeringId, i.subjectId, i.kind, i.language, i.sha256, i.sessionHash, i.deviceHash, i.actor],
    asBig,
  ),
  reserve: act(
    z.strictObject({
      offeringId: uuid,
      subjectId: uuid,
      units: count,
      category: z.enum(["retail", "sophisticated"]).default("retail"),
      idempotencyKey: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9:._-]{7,99}$/),
      actor,
    }),
    "SELECT offering.reserve($1, $2, $3, $4, $5, $6, $7, $8) AS r",
    (i) => {
      // One subscription = one refId (I-11). A repeated request returns the first subscription.
      const subscriptionId = randomUUID();
      return [i.offeringId, subscriptionId, refIdFor(subscriptionId), i.subjectId, i.units, i.category, i.idempotencyKey, i.actor];
    },
    asView,
  ),
  recheck: act(z.strictObject({ subscriptionId: uuid, actor }), "SELECT offering.recheck($1, $2) AS r", (i) => [i.subscriptionId, i.actor], asView),
  cancel: act(
    z.strictObject({ subscriptionId: uuid, subjectId: uuid, actor }),
    "SELECT offering.cancel($1, $2, $3) AS r",
    (i) => [i.subscriptionId, i.subjectId, i.actor],
    asView,
  ),
  withdraw: act(
    z.strictObject({ subscriptionId: uuid, subjectId: uuid, actor }),
    "SELECT offering.withdraw($1, $2, $3) AS r",
    (i) => [i.subscriptionId, i.subjectId, i.actor],
    asView,
  ),

  // ---- system jobs (pt_offering_service)
  tick: act(z.strictObject({ offeringId: uuid, actor }), "SELECT offering.tick($1, $2) AS r", (i) => [i.offeringId, i.actor], asRecord),
  syncPayment: act(
    z.strictObject({ subscriptionId: uuid, actor }),
    "SELECT offering.sync_payment($1, $2) AS r",
    (i) => [i.subscriptionId, i.actor],
    asView,
  ),
  startMinting: act(z.strictObject({ offeringId: uuid, actor }), "SELECT offering.start_minting($1, $2) AS r", (i) => [i.offeringId, i.actor], asInt),
  settle: act(
    z.strictObject({ offeringId: uuid, actor }),
    "SELECT offering.settle($1, $2) AS r",
    (i) => [i.offeringId, i.actor],
    asSettle,
  ),
} as const;

export type ActionName = keyof typeof ACTIONS;
export type ActionInput<K extends ActionName> = z.input<(typeof ACTIONS)[K]["schema"]>;
export type ActionResult<K extends ActionName> = ReturnType<(typeof ACTIONS)[K]["result"]>;

export function isAction(name: string): name is ActionName {
  return Object.hasOwn(ACTIONS, name);
}

/** Validates the input and runs one operation; database refusals become OfferingError. */
export async function runAction<K extends ActionName>(db: Db, name: K, input: ActionInput<K>): Promise<ActionResult<K>> {
  // eslint-disable-next-line security/detect-object-injection -- name is a key of the fixed ACTIONS table
  const a = ACTIONS[name] as unknown as Action<z.ZodType, ActionResult<K>>;
  const parsed = a.schema.safeParse(input);
  if (!parsed.success) throw new OfferingError("INVALID_INPUT", z.prettifyError(parsed.error));
  try {
    const { rows } = await db.query<{ r: unknown }>(a.sql, a.params(parsed.data));
    return a.result(rows[0]?.r);
  } catch (e) {
    throw mapError(e);
  }
}

export interface RefundResult {
  raastRef: string;
  journal: string;
  state: string;
}

/**
 * Sends one approved refund (V20): the database records it first (journal, gate, OF-51 checks),
 * then the bank is instructed to return the credit under its own reference. A crash between the two
 * leaves a recorded refund that reconciliation shows as an unmatched ledger entry until the bank
 * instruction is repeated (returnCredit is idempotent at the bank, same reference).
 */
export async function executeRefund(db: pg.Pool, gateway: BankGateway, subscriptionId: string, by: string): Promise<RefundResult> {
  const input = z.strictObject({ subscriptionId: uuid, actor }).safeParse({ subscriptionId, actor: by });
  if (!input.success) throw new OfferingError("INVALID_INPUT", z.prettifyError(input.error));
  let r: RefundResult;
  try {
    const { rows } = await db.query<{ r: { raastRef: string; journal: number | string; state: string } }>("SELECT offering.execute_refund($1, $2) AS r", [subscriptionId, by]);
    const v = rows[0]?.r;
    if (!v) throw new Error("execute_refund returned nothing");
    r = { raastRef: v.raastRef, journal: String(v.journal), state: v.state };
  } catch (e) {
    throw mapError(e);
  }
  await gateway.returnCredit(r.raastRef);
  return r;
}

/** Sends every approved, unsent refund of an offering; returns what was sent. */
export async function executeApprovedRefunds(db: pg.Pool, gateway: BankGateway, offeringId: string, by: string): Promise<RefundResult[]> {
  const { rows } = await db.query<{ subscription_id: string }>(
    `SELECT f.subscription_id FROM offering.refunds f JOIN offering.requests q ON q.id = f.request_id JOIN offering.subscriptions s ON s.id = f.subscription_id
     WHERE s.offering_id = $1 AND q.status = 'approved' AND f.journal_id IS NULL ORDER BY f.created_at, f.subscription_id`,
    [offeringId],
  );
  const out: RefundResult[] = [];
  for (const r of rows) out.push(await executeRefund(db, gateway, r.subscription_id, by));
  return out;
}

// ------------------------------------------------------------------ reads (portal and CLI)
export interface OfferingOverview {
  offeringId: string;
  propertyId: string;
  state: string;
  token: string | null;
  pricePaisa: string | null;
  hardCapUnits: string | null;
  minRaiseUnits: string | null;
  closesAt: Date | null;
  heldUnits: string;
  reservedUnits: string;
  paidUnits: string;
  waitlistedUnits: string;
}

export async function offeringOverview(db: Db, offeringId: string): Promise<OfferingOverview | null> {
  const { rows } = await db.query<{
    offering_id: string;
    property_id: string;
    state: string;
    token: string | null;
    price_paisa: string | null;
    hard_cap_units: string | null;
    min_raise_units: string | null;
    closes_at: Date | null;
    held_units: string;
    reserved_units: string;
    paid_units: string;
    waitlisted_units: string;
  }>("SELECT * FROM offering.overview WHERE offering_id = $1", [offeringId]);
  const r = rows[0];
  return r
    ? {
        offeringId: r.offering_id,
        propertyId: r.property_id,
        state: r.state,
        token: r.token,
        pricePaisa: r.price_paisa,
        hardCapUnits: r.hard_cap_units,
        minRaiseUnits: r.min_raise_units,
        closesAt: r.closes_at,
        heldUnits: r.held_units,
        reservedUnits: r.reserved_units,
        paidUnits: r.paid_units,
        waitlistedUnits: r.waitlisted_units,
      }
    : null;
}

export async function subscriptionsOf(db: Db, offeringId: string): Promise<{ subscriptionId: string; subjectId: string; state: string; units: string; paymentCode: string | null }[]> {
  const { rows } = await db.query<{ subscription_id: string; subject_id: string; state: string; units: string; payment_code: string | null }>(
    "SELECT subscription_id, subject_id, state, units::text, payment_code FROM offering.investor_subscriptions WHERE offering_id = $1 ORDER BY created_at, subscription_id",
    [offeringId],
  );
  return rows.map((r) => ({ subscriptionId: r.subscription_id, subjectId: r.subject_id, state: r.state, units: r.units, paymentCode: r.payment_code }));
}

/** OF-43 issuance dry run on the read model (empty = clean). */
export async function dryRun(db: Db, offeringId: string): Promise<{ subscriptionId: string | null; problem: string }[]> {
  const { rows } = await db.query<{ subscription_id: string | null; problem: string }>("SELECT * FROM offering.dry_run($1)", [offeringId]);
  return rows.map((r) => ({ subscriptionId: r.subscription_id, problem: r.problem }));
}

export interface QueueItem {
  requestId: string;
  offeringId: string;
  code: string;
  subscriptionId: string | null;
  requestedBy: string;
  since: Date;
}

/** Open maker-checker requests waiting for officers. */
export async function workQueue(db: Db): Promise<QueueItem[]> {
  const { rows } = await db.query<{ id: string; offering_id: string; code: string; subscription_id: string | null; requested_by: string; requested_at: Date }>(
    "SELECT id, offering_id, code, subscription_id, requested_by, requested_at FROM offering.requests WHERE status = 'open' ORDER BY requested_at, id",
  );
  return rows.map((r) => ({ requestId: r.id, offeringId: r.offering_id, code: r.code, subscriptionId: r.subscription_id, requestedBy: r.requested_by, since: r.requested_at }));
}

/** Offerings a scheduler should tick (not yet terminal). */
export async function activeOfferings(db: Db): Promise<string[]> {
  const { rows } = await db.query<{ id: string }>("SELECT id FROM offering.offerings WHERE state NOT IN ('draft', 'completed', 'cancelled') ORDER BY created_at, id");
  return rows.map((r) => r.id);
}

export async function verifyAudit(db: Db): Promise<{ auditId: string | null; problem: string }[]> {
  const { rows } = await db.query<{ audit_id: string | null; problem: string }>("SELECT audit_id::text, problem FROM offering.verify_audit()");
  return rows.map((r) => ({ auditId: r.audit_id, problem: r.problem }));
}
