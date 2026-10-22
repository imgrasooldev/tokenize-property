import { z } from "zod";

/**
 * Presentation rules of the investor exit page (spec S-05 sections 14-15, migration 0027). Every
 * business rule (who may request, windows, caps, free balance, prices, the exit state machine, the
 * final entitlement) is decided by the exit.* SQL functions behind the webauth.web_* wrappers; this
 * file only checks the shape of form input, parses the overview the database returns, maps states
 * and refusals to message keys and formats numbers. Money stays in integer paisa (bigint).
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const WHOLE = /^[0-9]{1,30}$/;
const ID = /^[1-9][0-9]{0,17}$/;

/** The request form: one window, whole units; the free balance and the window cap are checked in the database. */
export const redemptionRequestSchema = z.object({
  windowId: z.string().trim().regex(ID),
  units: z
    .string()
    .trim()
    .regex(/^[1-9][0-9]{0,17}$/, "whole number of units")
    .transform((s) => BigInt(s)),
  requestId: z.uuid({ version: "v4" }),
});
export type RedemptionRequestInput = z.output<typeof redemptionRequestSchema>;

export const redemptionWithdrawSchema = z.object({ requestId: z.string().regex(UUID) });

/** The backend's idempotency key for one website request (exit.request_redemption: ^[A-Za-z0-9][A-Za-z0-9:._-]{7,99}$). */
export const exitIdempotencyKey = (requestId: string): string => `web-exit-${requestId}`;

/** A discount in parts per million as a percentage text without trailing zeros ("5", "12.5", "0.0001"). */
export function ppmPercent(ppm: number): string {
  if (!Number.isInteger(ppm) || ppm < 0) return "—";
  const whole = Math.floor(ppm / 10_000);
  const frac = String(ppm % 10_000).padStart(4, "0").replace(/0+$/, "");
  return frac ? `${String(whole)}.${frac}` : String(whole);
}

/** "0x1234…cdef" for a token or wallet address. */
export const shortAddress = (a: string): string => (a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);

// ------------------------------------------------------------------ the overview (webauth.web_exit_overview)

export const EXIT_STATES = [
  "proposed",
  "vote_open",
  "trustee_review",
  "buyer_dd",
  "contracted",
  "completed_sale",
  "waterfall",
  "final_published",
  "final_finalized",
  "redeeming",
  "paid_out",
  "closed",
  "rejected",
  "sale_collapsed",
] as const;
export type ExitState = (typeof EXIT_STATES)[number];
export const isExitState = (s: string): s is ExitState => (EXIT_STATES as readonly string[]).includes(s);

export const PAYMENT_STATES = ["paid", "held", "in_payment", "unpaid", "nothing_to_pay"] as const;
export type PaymentState = (typeof PAYMENT_STATES)[number];

export const REQUEST_STATES = ["submitted", "withdrawn", "recorded", "under_review"] as const;
export type RequestState = (typeof REQUEST_STATES)[number];

export interface ExitFinal {
  status: string;
  grossPaisa: bigint;
  whtPaisa: bigint;
  netPaisa: bigint;
  units: bigint;
  distributionId: string | null;
  /** null while the redemption batch is not approved yet. */
  payment: PaymentState | null;
  burned: boolean;
}

export interface ExitCase {
  caseId: string;
  state: ExitState;
  recordDate: string | null;
  voteOpenedAt: string | null;
  salePricePaisa: bigint | null;
  updatedAt: string | null;
  final: ExitFinal | null;
}

export interface RedemptionWindow {
  id: string;
  opensAt: string;
  closesAt: string;
  navPerUnitPaisa: bigint;
  discountPpm: number;
  pricePerUnitPaisa: bigint;
  open: boolean;
  full: boolean;
}

export interface ExitHolding {
  token: string;
  units: bigint;
  paused: boolean;
  exit: ExitCase | null;
  windows: RedemptionWindow[];
}

export interface RedemptionRequest {
  id: string;
  token: string;
  windowId: string;
  units: bigint;
  pricePerUnitPaisa: bigint;
  indicativePaisa: bigint;
  status: RequestState;
  withdrawable: boolean;
  createdAt: string | null;
}

export interface ExitOverview {
  verified: boolean;
  wallet: string | null;
  holdings: ExitHolding[];
  requests: RedemptionRequest[];
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const get = (o: Obj, k: string): unknown => new Map(Object.entries(o)).get(k);
const str = (v: unknown): string | null => (typeof v === "string" ? v : typeof v === "number" && Number.isFinite(v) ? String(v) : null);
function whole(v: unknown): bigint {
  const s = str(v);
  if (s === null || !WHOLE.test(s)) throw new Error("expected a whole number");
  return BigInt(s);
}
const wholeOrNull = (v: unknown): bigint | null => (v === null || v === undefined ? null : whole(v));
function date(v: unknown): string | null {
  const s = str(v);
  return s !== null && !Number.isNaN(Date.parse(s)) ? s : null;
}
function address(v: unknown): string {
  const s = str(v);
  if (s === null || !ADDRESS.test(s)) throw new Error("expected an address");
  return s.toLowerCase();
}
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

function parseFinal(v: unknown): ExitFinal | null {
  if (!isObj(v)) return null;
  const p = str(get(v, "payment"));
  return {
    status: str(get(v, "status")) ?? "",
    grossPaisa: whole(get(v, "grossPaisa")),
    whtPaisa: whole(get(v, "whtPaisa")),
    netPaisa: whole(get(v, "netPaisa")),
    units: whole(get(v, "units")),
    distributionId: str(get(v, "distributionId")),
    payment: p !== null && (PAYMENT_STATES as readonly string[]).includes(p) ? (p as PaymentState) : null,
    burned: get(v, "burned") === true,
  };
}

function parseCase(v: unknown): ExitCase | null {
  if (!isObj(v)) return null;
  const state = str(get(v, "state")) ?? "";
  if (!isExitState(state)) return null;
  return {
    caseId: str(get(v, "case")) ?? "",
    state,
    recordDate: date(get(v, "recordDate")),
    voteOpenedAt: date(get(v, "voteOpenedAt")),
    salePricePaisa: wholeOrNull(get(v, "salePricePaisa")),
    updatedAt: date(get(v, "updatedAt")),
    final: parseFinal(get(v, "final")),
  };
}

function parseWindow(v: unknown): RedemptionWindow | null {
  if (!isObj(v)) return null;
  const id = str(get(v, "id"));
  const opensAt = date(get(v, "opensAt"));
  const closesAt = date(get(v, "closesAt"));
  const discount = Number(get(v, "discountPpm"));
  if (id === null || !ID.test(id) || !opensAt || !closesAt || !Number.isInteger(discount)) return null;
  return {
    id,
    opensAt,
    closesAt,
    navPerUnitPaisa: whole(get(v, "navPerUnitPaisa")),
    discountPpm: discount,
    pricePerUnitPaisa: whole(get(v, "pricePerUnitPaisa")),
    open: get(v, "open") === true,
    full: get(v, "full") === true,
  };
}

function parseRequest(v: unknown): RedemptionRequest | null {
  if (!isObj(v)) return null;
  const id = str(get(v, "id"));
  const windowId = str(get(v, "window"));
  const raw = str(get(v, "status")) ?? "";
  // Anything the website does not know reads as "under review" (never a raw backend state).
  const status: RequestState = (REQUEST_STATES as readonly string[]).includes(raw) ? (raw as RequestState) : "under_review";
  if (id === null || !UUID.test(id) || windowId === null) return null;
  return {
    id,
    token: address(get(v, "token")),
    windowId,
    units: whole(get(v, "units")),
    pricePerUnitPaisa: whole(get(v, "pricePerUnitPaisa")),
    indicativePaisa: whole(get(v, "indicativePaisa")),
    status,
    withdrawable: status === "submitted" && get(v, "withdrawable") === true,
    createdAt: date(get(v, "createdAt")),
  };
}

/** Parses webauth.web_exit_overview's answer; "session" when the session is gone; throws on a malformed answer. */
export function parseOverview(v: unknown): ExitOverview | "session" {
  if (!isObj(v)) throw new Error("exit overview: not an object");
  if (get(v, "error") !== undefined) return "session";
  const holdings: ExitHolding[] = arr(get(v, "holdings")).flatMap((h) => {
    if (!isObj(h)) return [];
    return [
      {
        token: address(get(h, "token")),
        units: whole(get(h, "units")),
        paused: get(h, "paused") === true,
        exit: parseCase(get(h, "exit")),
        windows: arr(get(h, "windows")).flatMap((x) => parseWindow(x) ?? []),
      },
    ];
  });
  const wallet = get(v, "wallet");
  return {
    verified: get(v, "verified") === true,
    wallet: wallet === undefined || wallet === null ? null : address(wallet),
    holdings,
    requests: arr(get(v, "requests")).flatMap((x) => parseRequest(x) ?? []),
  };
}

// ------------------------------------------------------------------ the exit timeline

/** The steps an investor sees, in order (the internal "waterfall" settlement shows as "sale completed"). */
export const EXIT_STEPS = [
  "vote_open",
  "trustee_review",
  "buyer_dd",
  "contracted",
  "completed_sale",
  "final_published",
  "final_finalized",
  "redeeming",
  "paid_out",
  "closed",
] as const;
export type ExitStep = (typeof EXIT_STEPS)[number];
export type ExitStepStatus = "done" | "current" | "todo";

export interface ExitTimeline {
  steps: { step: ExitStep; status: ExitStepStatus }[];
  /** The exit left the path: it did not go ahead (vote or trustee) or the sale collapsed. */
  outcome: "rejected" | "sale_collapsed" | null;
}

/**
 * Steps already passed are done, the step the case stands at is current (closed: everything done).
 * A case that did not go ahead shows no progress and an outcome (no history is shared with investors).
 */
export function exitTimeline(state: ExitState): ExitTimeline {
  if (state === "rejected" || state === "sale_collapsed") return { steps: EXIT_STEPS.map((step) => ({ step, status: "todo" })), outcome: state };
  const at = state === "proposed" ? -1 : state === "waterfall" ? EXIT_STEPS.indexOf("completed_sale") : EXIT_STEPS.indexOf(state);
  const steps = EXIT_STEPS.map((step, i) => {
    const status: ExitStepStatus = i < at || (state === "closed" && i === at) ? "done" : i === at ? "current" : "todo";
    return { step, status };
  });
  return { steps, outcome: null };
}

/** A window accepts a request from this investor now: open, not full, verified, holding units, no live request in it. */
export function canRequest(w: RedemptionWindow, holding: ExitHolding, verified: boolean, requests: RedemptionRequest[]): boolean {
  if (!verified || !w.open || w.full || holding.units <= 0n) return false;
  return !requests.some((r) => r.windowId === w.id && r.status === "submitted");
}

export type ExitTone = "ok" | "warn" | "bad" | "gray" | "cy";
export function requestTone(s: RequestState): ExitTone {
  if (s === "recorded") return "ok";
  if (s === "submitted" || s === "under_review") return "warn";
  return "gray";
}
export function paymentTone(p: PaymentState | null): ExitTone {
  if (p === "paid" || p === "nothing_to_pay") return "ok";
  if (p === "held") return "bad";
  if (p === "in_payment") return "cy";
  return "warn";
}

// ------------------------------------------------------------------ refusals

/** stepup / enrolPasskey / session: the passkey gate (migration 0024) refused. */
export type RedemptionErrorKey =
  | "input"
  | "rate"
  | "kyc"
  | "window"
  | "closed"
  | "exitUnderway"
  | "frozen"
  | "balance"
  | "already"
  | "full"
  | "generic"
  | "stepup"
  | "enrolPasskey"
  | "session";

/**
 * Maps the refusal of exit.request_redemption / webauth.web_redemption_request (SQLSTATE and its
 * investor-safe message) to a message key. The database decides; this only picks the right words.
 * Anything unexpected is "generic": no backend text reaches the page.
 */
export function redemptionErrorKey(code: string | undefined, message: string): RedemptionErrorKey {
  if (code === "42501") return "kyc";
  if (code === "P0002") return "window";
  if (code === "23505") return "already";
  if (code === "22023") return "input";
  if (code === "23514") {
    if (/window is not open/.test(message)) return "closed";
    if (/exit is under way/.test(message)) return "exitUnderway";
    if (/cannot be redeemed at the moment/.test(message)) return "frozen";
    if (/at most the units you hold/.test(message)) return "balance";
    if (/window is full/.test(message)) return "full";
  }
  return "generic";
}

export type WithdrawErrorKey = "input" | "rate" | "unknown" | "state" | "closed" | "generic" | "stepup" | "enrolPasskey" | "session";

export function withdrawErrorKey(code: string | undefined, message: string): WithdrawErrorKey {
  if (code === "P0002") return "unknown";
  if (code === "23514") return /window has closed/.test(message) ? "closed" : "state";
  return "generic";
}

/** The passkey gate's answer inside the webauth wrappers. */
export function gateErrorKey(r: unknown): "stepup" | "enrolPasskey" | "session" | null {
  if (!isObj(r)) return null;
  const e = get(r, "error");
  if (e === undefined || e === null) return null;
  return e === "step_up" ? "stepup" : e === "enrol" ? "enrolPasskey" : "session";
}
