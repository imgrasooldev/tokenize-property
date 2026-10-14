import { randomUUID } from "node:crypto";
import { refIdFor } from "../invest-rules";
import { idempotencyKey, reserveErrorKey, cancelErrorKey, type CancelErrorKey, type ReserveErrorKey, type ReserveInput } from "../offering-rules";
import { db, tx, type InvestorRow } from "./db";

/**
 * The investor side of the offering lifecycle (spec S-02) on the website. Thin client of the
 * offering.web_* SQL functions (migration 0018), called with the website's own role (pt_web): reads
 * of public offering data and of the signed-in investor's subscriptions, document acceptance,
 * reservation and cancellation. Every rule is enforced in the database; nothing here decides.
 */

export interface PublicOffering {
  offeringId: string;
  state: string;
  token: string | null;
  pricePaisa: bigint;
  minRaiseUnits: bigint;
  targetUnits: bigint;
  hardCapUnits: bigint;
  minUnits: bigint;
  maxUnits: bigint;
  maxHoldingUnits: bigint | null;
  opensAt: string | null;
  closesAt: string | null;
  extended: boolean;
  paymentGraceMinutes: number;
  reservationMinutes: number;
  completionDays: number;
  completionDeadline: string | null;
  earlyClose: boolean;
  allOrNothing: boolean;
  categories: string[];
  useOfProceeds: { line: string; paisa: bigint }[];
  docEnSha: string | null;
  docUrSha: string | null;
  riskSha: string | null;
  paidUnits: bigint;
  heldUnits: bigint;
  availableUnits: bigint;
  waitlistedUnits: bigint;
  withdrawalUntil: string | null;
  fundedAt: string | null;
  completedAt: string | null;
  failedAt: string | null;
  province: string | null;
  district: string | null;
  use: string | null;
  coveredAreaSqft: string | null;
}

interface OfferingRow {
  offering_id: string;
  state: string;
  token: string | null;
  price_paisa: string;
  min_raise_units: string;
  target_units: string;
  hard_cap_units: string;
  min_units: string;
  max_units: string;
  max_holding_units: string | null;
  opens_at: Date | null;
  closes_at: Date | null;
  extended: boolean;
  payment_grace_minutes: number;
  reservation_minutes: number;
  completion_days: number;
  completion_deadline: Date | null;
  early_close: boolean;
  all_or_nothing: boolean;
  categories: string[];
  use_of_proceeds: unknown;
  doc_en_sha: string | null;
  doc_ur_sha: string | null;
  risk_sha: string | null;
  paid_units: string;
  held_units: string;
  available_units: string;
  waitlisted_units: string;
  withdrawal_until: Date | null;
  funded_at: Date | null;
  completed_at: Date | null;
  failed_at: Date | null;
  province: string | null;
  district: string | null;
  property_use: string | null;
  covered_area_sqft: string | null;
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);
const big = (s: string | null): bigint => BigInt(s ?? "0");

function proceeds(v: unknown): { line: string; paisa: bigint }[] {
  if (!Array.isArray(v)) return [];
  const out: { line: string; paisa: bigint }[] = [];
  for (const x of v as unknown[]) {
    const r = x as { line?: unknown; paisa?: unknown };
    if (typeof r.line === "string" && /^[a-z][a-z0-9_]{2,40}$/.test(r.line) && (typeof r.paisa === "string" || typeof r.paisa === "number") && /^[0-9]{1,18}$/.test(String(r.paisa))) {
      out.push({ line: r.line, paisa: BigInt(String(r.paisa)) });
    }
  }
  return out;
}

function toOffering(r: OfferingRow): PublicOffering {
  return {
    offeringId: r.offering_id,
    state: r.state,
    token: r.token,
    pricePaisa: big(r.price_paisa),
    minRaiseUnits: big(r.min_raise_units),
    targetUnits: big(r.target_units),
    hardCapUnits: big(r.hard_cap_units),
    minUnits: big(r.min_units),
    maxUnits: big(r.max_units),
    maxHoldingUnits: r.max_holding_units === null ? null : BigInt(r.max_holding_units),
    opensAt: iso(r.opens_at),
    closesAt: iso(r.closes_at),
    extended: r.extended,
    paymentGraceMinutes: r.payment_grace_minutes,
    reservationMinutes: r.reservation_minutes,
    completionDays: r.completion_days,
    completionDeadline: iso(r.completion_deadline),
    earlyClose: r.early_close,
    allOrNothing: r.all_or_nothing,
    categories: r.categories,
    useOfProceeds: proceeds(r.use_of_proceeds),
    docEnSha: r.doc_en_sha,
    docUrSha: r.doc_ur_sha,
    riskSha: r.risk_sha,
    paidUnits: big(r.paid_units),
    heldUnits: big(r.held_units),
    availableUnits: big(r.available_units),
    waitlistedUnits: big(r.waitlisted_units),
    withdrawalUntil: iso(r.withdrawal_until),
    fundedAt: iso(r.funded_at),
    completedAt: iso(r.completed_at),
    failedAt: iso(r.failed_at),
    province: r.province,
    district: r.district,
    use: r.property_use,
    coveredAreaSqft: r.covered_area_sqft,
  };
}

/** Offerings an investor may see (approved and later), newest open first. */
export async function listOfferings(): Promise<PublicOffering[]> {
  const { rows } = await (await db()).query<OfferingRow>("SELECT * FROM offering.web_offerings()");
  return rows.map(toOffering);
}

export async function offeringById(id: string): Promise<PublicOffering | null> {
  const { rows } = await (await db()).query<OfferingRow>("SELECT * FROM offering.web_offerings($1)", [id]);
  return rows[0] ? toOffering(rows[0]) : null;
}

export interface MySubscription {
  subscriptionId: string;
  offeringId: string;
  offeringState: string;
  token: string | null;
  state: string;
  units: bigint;
  amountPaisa: bigint;
  paymentCode: string | null;
  payToAccount: string | null;
  expiresAt: string | null;
  reservedAt: string | null;
  paidAt: string | null;
  publicReason: string | null;
  mintTx: string | null;
  refundCause: string | null;
  refundStatus: "requested" | "approved" | "sent" | "in_review" | null;
  refundSentAt: string | null;
  createdAt: string;
  events: { code: string; toState: string; at: string }[];
}

interface SubRow {
  subscription_id: string;
  offering_id: string;
  offering_state: string;
  token: string | null;
  state: string;
  units: string;
  amount_paisa: string;
  payment_code: string | null;
  pay_to_account: string | null;
  expires_at: Date | null;
  reserved_at: Date | null;
  paid_at: Date | null;
  public_reason: string | null;
  mint_tx: string | null;
  refund_cause: string | null;
  refund_status: MySubscription["refundStatus"];
  refund_sent_at: Date | null;
  created_at: Date;
}

/** The signed-in investor's subscriptions with their state history (scoped to the investor's KYC subject). */
export async function mySubscriptions(investor: Pick<InvestorRow, "kyc_subject">): Promise<MySubscription[]> {
  if (!investor.kyc_subject) return [];
  const pool = await db();
  const [subs, events] = await Promise.all([
    pool.query<SubRow>("SELECT * FROM offering.web_subscriptions($1)", [investor.kyc_subject]),
    pool.query<{ subscription_id: string; code: string; to_state: string; at: Date }>("SELECT * FROM offering.web_subscription_events($1)", [investor.kyc_subject]),
  ]);
  return subs.rows.map((r) => ({
    subscriptionId: r.subscription_id,
    offeringId: r.offering_id,
    offeringState: r.offering_state,
    token: r.token,
    state: r.state,
    units: BigInt(r.units),
    amountPaisa: BigInt(r.amount_paisa),
    paymentCode: r.payment_code,
    payToAccount: r.pay_to_account,
    expiresAt: iso(r.expires_at),
    reservedAt: iso(r.reserved_at),
    paidAt: iso(r.paid_at),
    publicReason: r.public_reason,
    mintTx: r.mint_tx,
    refundCause: r.refund_cause,
    refundStatus: r.refund_status,
    refundSentAt: iso(r.refund_sent_at),
    createdAt: r.created_at.toISOString(),
    events: events.rows.filter((e) => e.subscription_id === r.subscription_id).map((e) => ({ code: e.code, toState: e.to_state, at: e.at.toISOString() })),
  }));
}

/** Website actor recorded in the offering audit (migration 0018 WO-3). */
export const webActor = (investorId: string): string => `web:${investorId}`;

export type ReserveResult = { subscriptionId: string; state: string } | { error: ReserveErrorKey };

/** The passkey gate's answer inside webauth.web_reserve / web_cancel (migration 0024 IP-6). */
function gateError(r: { error?: string } | undefined): "stepup" | "enrolPasskey" | "session" | null {
  if (!r?.error) return null;
  return r.error === "step_up" ? "stepup" : r.error === "enrol" ? "enrolPasskey" : "session";
}

/**
 * Accepts the shown document versions (OF-10) and reserves in ONE transaction (V2/V3): the database
 * checks the versions, KYC, eligibility, limits and free units, and returns the reservation with its
 * payment code, or a waitlist place. A repeated request (same requestId) returns the same subscription.
 * Since T-030 the reservation goes through webauth.web_reserve: the database takes the investor and
 * KYC subject from the session and asks for a passkey step-up from PKR 100,000 (migration 0024).
 * A refusal of the gate still commits the document acceptance and the gate's audit entry.
 */
export async function reserveUnits(
  investor: Pick<InvestorRow, "id" | "kyc_subject">,
  input: ReserveInput,
  context: { session: Buffer; sessionHash: string; deviceHash: string },
): Promise<ReserveResult> {
  if (!investor.kyc_subject) return { error: "kyc" };
  const actor = webActor(investor.id);
  const subscriptionId = randomUUID();
  try {
    return await tx(async (c) => {
      for (const [kind, sha] of [
        ["offering_document", input.docSha],
        ["risk_disclosure", input.riskSha],
      ] as const) {
        await c.query("SELECT offering.web_accept_document($1, $2, $3, $4, $5, $6, $7, $8)", [
          input.offeringId,
          investor.kyc_subject,
          kind,
          input.language,
          sha,
          context.sessionHash,
          context.deviceHash,
          actor,
        ]);
      }
      const { rows } = await c.query<{ r: { subscriptionId: string; state: string; error?: string } }>("SELECT webauth.web_reserve($1, $2, $3, $4, $5, $6) AS r", [
        context.session,
        input.offeringId,
        subscriptionId,
        refIdFor(subscriptionId),
        input.units.toString(),
        idempotencyKey(input.requestId),
      ]);
      const r = rows[0]?.r;
      if (!r) throw new Error("web_reserve returned nothing");
      const gate = gateError(r);
      if (gate) return { error: gate };
      return { subscriptionId: r.subscriptionId, state: r.state };
    });
  } catch (e) {
    const err = e as { code?: string; message?: string };
    if (typeof err.code === "string" && /^(42501|P0002|23505|22023|23514)$/.test(err.code)) return { error: reserveErrorKey(err.code, err.message ?? "") };
    throw e;
  }
}

export type CancelResult = { state: string } | { error: CancelErrorKey };

/**
 * V11: cancels the investor's own reservation or queue place before payment (the backend checks
 * ownership and state), through webauth.web_cancel: always behind a passkey step-up (T-030).
 */
export async function cancelSubscription(investor: Pick<InvestorRow, "id" | "kyc_subject">, subscriptionId: string, session: Buffer): Promise<CancelResult> {
  if (!investor.kyc_subject) return { error: "unknown" };
  try {
    const { rows } = await (await db()).query<{ r: { state: string; error?: string } }>("SELECT webauth.web_cancel($1, $2) AS r", [session, subscriptionId]);
    const gate = gateError(rows[0]?.r);
    if (gate) return { error: gate };
    return { state: rows[0]?.r.state ?? "unknown" };
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "P0002" || code === "23514") return { error: cancelErrorKey(code) };
    throw e;
  }
}
