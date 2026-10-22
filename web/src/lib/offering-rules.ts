import { z } from "zod";
import type { Lang } from "./i18n";

/**
 * Presentation rules for the investor offering screens (spec S-02, migration 0018). Every business
 * rule (units, limits, FCFS, waitlist, expiry, KYC, refunds) is decided by the offering.* SQL
 * functions; this file only checks the shape of form input, formats amounts (integer paisa, never
 * floats) and times (PKT), and maps the backend's states to what the investor sees.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{64}$/;

export const isUuid = (s: string): boolean => UUID.test(s);

/** The reserve form. Units are whole and positive; the offering's own limits are checked in the database. */
export const reserveSchema = z.object({
  offeringId: z.string().regex(UUID),
  units: z
    .string()
    .trim()
    .regex(/^[1-9][0-9]{0,12}$/, "whole number of units")
    .transform((s) => BigInt(s)),
  requestId: z.uuid({ version: "v4" }),
  language: z.enum(["en", "ur"]),
  docSha: z.string().regex(SHA),
  riskSha: z.string().regex(SHA),
  acceptDoc: z.literal("on"),
  acceptRisk: z.literal("on"),
});
export type ReserveInput = z.output<typeof reserveSchema>;

export const cancelSchema = z.object({ subscriptionId: z.string().regex(UUID) });

/** The backend's idempotency key for one website request (offering.reserve, OF-17). */
export const idempotencyKey = (requestId: string): string => `web-${requestId}`;

/** Price x units in paisa, exact. */
export function totalPaisa(units: bigint, pricePaisa: bigint): bigint {
  if (units < 0n || pricePaisa < 0n) throw new Error("amounts are never negative");
  return units * pricePaisa;
}

/** "Rs 1,234.50" from integer paisa, without floating point (bigint all the way). */
export function formatPaisa(paisa: bigint, lang: Lang): string {
  const negative = paisa < 0n;
  const abs = negative ? -paisa : paisa;
  const rupees = abs / 100n;
  const cents = (abs % 100n).toString().padStart(2, "0");
  const parts = new Intl.NumberFormat(lang === "ur" ? "ur-PK" : "en-PK", { style: "currency", currency: "PKR", minimumFractionDigits: 2, maximumFractionDigits: 2 }).formatToParts(rupees);
  const text = parts.map((p) => (p.type === "fraction" ? cents : p.value)).join("");
  return negative ? `-${text}` : text;
}

/** Share of the hard cap, in basis points (0..10000), integer arithmetic. */
export function progressBp(part: bigint, whole: bigint): number {
  if (whole <= 0n || part <= 0n) return 0;
  const bp = (part * 10_000n) / whole;
  return Number(bp > 10_000n ? 10_000n : bp);
}

/** Basis points as a percentage text with two decimals ("12.34"). */
export const bpText = (bp: number): string => `${String(Math.floor(bp / 100))}.${String(bp % 100).padStart(2, "0")}`;

/** Pakistan Standard Time is UTC+5 all year (no daylight saving). */
const PKT_OFFSET_MS = 5 * 60 * 60 * 1000;
const MONTHS = {
  en: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
  ur: ["جنوری", "فروری", "مارچ", "اپریل", "مئی", "جون", "جولائی", "اگست", "ستمبر", "اکتوبر", "نومبر", "دسمبر"],
} as const;

/** "13 Oct 2026, 17:05 PKT" (deterministic: fixed offset, not the viewer's or server's zone). */
export function formatPkt(at: Date | string | null, lang: Lang): string {
  if (at === null) return "—";
  const d = typeof at === "string" ? new Date(at) : at;
  if (Number.isNaN(d.getTime())) return "—";
  const p = new Date(d.getTime() + PKT_OFFSET_MS);
  const two = (n: number) => String(n).padStart(2, "0");
  const month = (lang === "ur" ? MONTHS.ur : MONTHS.en).at(p.getUTCMonth()) ?? "";
  return `${String(p.getUTCDate())} ${month} ${String(p.getUTCFullYear())}, ${two(p.getUTCHours())}:${two(p.getUTCMinutes())} PKT`;
}

/** Time left until `expiresAt`, as whole hours, minutes and seconds (zero once passed). */
export function countdown(expiresAt: Date | string, now: number): { done: boolean; h: number; m: number; s: number } {
  const end = typeof expiresAt === "string" ? Date.parse(expiresAt) : expiresAt.getTime();
  const left = Math.max(0, Math.floor((end - now) / 1000));
  return { done: left === 0, h: Math.floor(left / 3600), m: Math.floor((left % 3600) / 60), s: left % 60 };
}

export const countdownText = (c: { h: number; m: number; s: number }): string =>
  `${String(c.h)}:${String(c.m).padStart(2, "0")}:${String(c.s).padStart(2, "0")}`;

/** Subscription states as the website receives them (blocked/disputed arrive as under_review, WO-4). */
export const SUB_STATES = [
  "initiated",
  "kyc_pending",
  "waitlisted",
  "payment_pending",
  "payment_confirmed",
  "allocation_pending",
  "issuance_review",
  "tokens_issued",
  "active",
  "redeemed",
  "refund_pending",
  "refunded",
  "rejected",
  "expired",
  "cancelled",
  "under_review",
] as const;
export type SubState = (typeof SUB_STATES)[number];
export const isSubState = (s: string): s is SubState => (SUB_STATES as readonly string[]).includes(s);

/** The investor may cancel before paying (V11): a reservation, a KYC queue place or a waitlist place. */
export const canCancel = (s: string): boolean => s === "payment_pending" || s === "waitlisted" || s === "kyc_pending";

export type Tone = "ok" | "warn" | "bad" | "gray" | "cy";
export function stateTone(s: string): Tone {
  if (s === "tokens_issued" || s === "active" || s === "refunded") return "ok";
  if (s === "payment_pending" || s === "waitlisted" || s === "kyc_pending" || s === "refund_pending" || s === "under_review" || s === "issuance_review") return "warn";
  if (s === "rejected") return "bad";
  if (s === "expired" || s === "cancelled" || s === "redeemed") return "gray";
  return "cy";
}

/**
 * The four steps of a subscription (reserved -> paid -> allocated -> minted at completion) and
 * where this subscription stands; `outcome` is the terminal or side state when it left that path.
 */
export const STEPS = ["reserved", "paid", "allocated", "minted"] as const;
export type Step = (typeof STEPS)[number];
export type StepStatus = "done" | "current" | "todo" | "stopped";
export interface Timeline {
  steps: { step: Step; status: StepStatus; at: string | null }[];
  outcome: "waitlisted" | "kyc_pending" | "refund_pending" | "refunded" | "cancelled" | "expired" | "rejected" | "under_review" | "issuance_review" | "redeemed" | null;
}

const reached = new Map<SubState, number>(Object.entries({
  initiated: 0,
  kyc_pending: 0,
  waitlisted: 0,
  payment_pending: 1,
  payment_confirmed: 2,
  allocation_pending: 3,
  issuance_review: 3,
  tokens_issued: 4,
  active: 4,
  redeemed: 4,
  refund_pending: 2,
  refunded: 2,
  rejected: 0,
  expired: 1,
  cancelled: 1,
  under_review: 2,
} satisfies Record<SubState, number>) as [SubState, number][]);
const STEP_STATE = new Map<Step, readonly string[]>([
  ["reserved", ["payment_pending"]],
  ["paid", ["payment_confirmed"]],
  ["allocated", ["allocation_pending"]],
  ["minted", ["tokens_issued"]],
]);
const reaches = (step: Step, toState: string): boolean => STEP_STATE.get(step)?.includes(toState) ?? false;

/**
 * Builds the timeline from the current state and the state history (to_state + time). A cancelled
 * or expired subscription that was only queued (never reserved) has no reserved step done.
 */
export function timeline(state: string, events: { toState: string; at: string }[]): Timeline {
  const s: SubState = isSubState(state) ? state : "initiated";
  const firstAt = (step: Step): string | null => events.find((e) => reaches(step, e.toState))?.at ?? null;
  const wasReserved = events.some((e) => e.toState === "payment_pending");
  let done = reached.get(s) ?? 0;
  if ((s === "cancelled" || s === "expired") && !wasReserved) done = 0;
  if (s === "under_review" || s === "refund_pending" || s === "refunded") {
    // Paid at least; further steps as far as the history shows them.
    const seen = STEPS.reduce((n, step, i) => (events.some((e) => reaches(step, e.toState)) ? i + 1 : n), 0);
    done = Math.max(seen, 2);
  }
  const terminal = s === "cancelled" || s === "expired" || s === "rejected" || s === "refunded" || s === "refund_pending" || s === "under_review" || s === "redeemed";
  const steps = STEPS.map((step, i) => {
    let status: StepStatus;
    if (i < done) status = "done";
    else if (i === done && !terminal) status = "current";
    else if (i === done && terminal && s !== "redeemed") status = "stopped";
    else status = "todo";
    return { step, status, at: i < done ? firstAt(step) : null };
  });
  const outcome: Timeline["outcome"] =
    s === "waitlisted" || s === "kyc_pending" || s === "refund_pending" || s === "refunded" || s === "cancelled" || s === "expired" || s === "rejected" || s === "under_review" || s === "issuance_review" || s === "redeemed"
      ? s
      : null;
  return { steps, outcome };
}

/** stepup / enrolPasskey / session: the passkey gate of migration 0024 (T-030) refused. */
export type ReserveErrorKey = "input" | "rate" | "kyc" | "notOpen" | "units" | "docs" | "already" | "paused" | "unknown" | "generic" | "stepup" | "enrolPasskey" | "session";

/**
 * Maps the backend's refusal (SQLSTATE and message of offering.reserve / web_reserve, migrations
 * 0015 and 0018) to a message key. The database decides; this only picks the right words.
 */
export function reserveErrorKey(code: string | undefined, message: string): ReserveErrorKey {
  if (code === "42501") return "kyc";
  if (code === "P0002") return "unknown";
  if (code === "23505") return "already";
  if (code === "22023" && /units must be between/.test(message)) return "units";
  if (code === "23514") {
    if (/accept the offering document/.test(message) || /approved version/.test(message)) return "docs";
    if (/not open for subscriptions|ready or live/.test(message)) return "notOpen";
    if (/under review again/.test(message)) return "paused";
  }
  return "generic";
}

export type CancelErrorKey = "input" | "rate" | "state" | "unknown" | "generic" | "stepup" | "enrolPasskey" | "session";
export function cancelErrorKey(code: string | undefined): CancelErrorKey {
  if (code === "P0002") return "unknown";
  if (code === "23514") return "state";
  return "generic";
}
