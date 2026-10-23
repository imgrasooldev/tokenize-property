import { z } from "zod";
import { sha256Hex } from "./verify-rules";

/**
 * Presentation rules for the investor transfer screen (spec S-04 phase 0, section 16.9, migration
 * 0028). Every business rule (KYC, receive codes, lock-up, price band, checks, approvals, payment,
 * the 48-hour on-chain window) is decided by the transfer.* SQL functions behind the session-bound
 * webauth.web_transfer* wrappers; this file only checks the shape of form input, converts rupees to
 * integer paisa (never floats), maps the database's refusals to message keys and copies the
 * database's list into a fixed shape (nothing else, so no other investor's data can slip through).
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{64}$/;
const ADDRESS = /^0x[0-9a-f]{40}$/;
/** A receive code as transfer.new_code makes it (Crockford base 32). */
export const RECEIVE_CODE = /^TR-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;

export const CONSIDERATIONS = ["sale", "gift", "family"] as const;
export type Consideration = (typeof CONSIDERATIONS)[number];

/** What the buyer types: spaces and case do not matter (the database also trims and upper-cases). */
export const normaliseCode = (s: string): string => s.trim().toUpperCase().replace(/\s+/g, "");

/**
 * Mirror of compliance.free_text_ok (migration 0019): length within bounds after trimming and no
 * CNIC, IBAN or mobile number. A hint only; the database checks again.
 */
export function freeTextOk(s: string, min: number, max: number): boolean {
  const t = s.trim();
  return (
    t.length >= min &&
    t.length <= max &&
    !/[0-9]{13}/.test(s) &&
    !/[0-9]{5}[ -][0-9]{7}[ -][0-9]/.test(s) &&
    !/PK[0-9]{2} ?[A-Z]{4}/i.test(s) &&
    !/(\+92|0092)[ -]?3[0-9]{2}/.test(s) &&
    !/(^|[^0-9])03[0-9]{2}[ -]?[0-9]{7}/.test(s)
  );
}

/** Highest total the database accepts for a sale (insert_case: units x price <= 10^15 paisa). */
export const MAX_TOTAL_PAISA = 1_000_000_000_000_000n;

/** "1,000" or "1000.5" rupees -> integer paisa; null if it is not a positive amount with at most two decimals. */
export function rupeesToPaisa(s: string): bigint | null {
  const t = s.trim().replace(/,/g, "");
  const [whole = "", frac, extra] = t.split(".");
  if (extra !== undefined || !/^[0-9]{1,13}$/.test(whole) || (frac !== undefined && !/^[0-9]{1,2}$/.test(frac))) return null;
  const paisa = BigInt(whole) * 100n + BigInt((frac ?? "").padEnd(2, "0"));
  return paisa > 0n ? paisa : null;
}

const optionalText = (min: number, max: number) =>
  z
    .string()
    .nullish()
    .transform((s) => (s === null || s === undefined || s.trim() === "" ? null : s.trim()))
    .refine((s) => s === null || freeTextOk(s, min, max), "text");

/** The request form (seller). The database checks the token, holdings, limits and everything else. */
export const requestSchema = z
  .object({
    token: z.string().trim().toLowerCase().regex(ADDRESS),
    units: z
      .string()
      .trim()
      .regex(/^[1-9][0-9]{0,12}$/)
      .transform((s) => BigInt(s)),
    buyerCode: z.string().transform(normaliseCode).pipe(z.string().regex(RECEIVE_CODE)),
    consideration: z.enum(CONSIDERATIONS),
    price: z.string().nullish(),
    noPriceReason: z.string().nullish(),
    agreementSha256: z.string().trim().toLowerCase().regex(SHA),
    priceExplanation: optionalText(10, 1000),
    holdingReason: optionalText(10, 500),
  })
  .transform((v, ctx) => {
    const sale = v.consideration === "sale";
    const pricePaisa = sale ? rupeesToPaisa(v.price ?? "") : null;
    const reason = (v.noPriceReason ?? "").trim();
    if (sale && (pricePaisa === null || pricePaisa * v.units > MAX_TOTAL_PAISA)) {
      ctx.addIssue({ code: "custom", path: ["price"], message: "price" });
      return z.NEVER;
    }
    if (!sale && !freeTextOk(reason, 10, 500)) {
      ctx.addIssue({ code: "custom", path: ["noPriceReason"], message: "reason" });
      return z.NEVER;
    }
    return {
      token: v.token,
      units: v.units,
      buyerCode: v.buyerCode,
      consideration: v.consideration,
      pricePaisa,
      noPriceReason: sale ? null : reason,
      agreementSha256: v.agreementSha256,
      priceExplanation: v.priceExplanation,
      holdingReason: v.holdingReason,
    };
  });
export type RequestInput = z.output<typeof requestSchema>;

export const acceptSchema = z.object({ caseId: z.string().regex(UUID), agreementSha256: z.string().trim().toLowerCase().regex(SHA) });
export const withdrawSchema = z.object({ caseId: z.string().regex(UUID) });

/** The first issue of a failed request form, as a message key (price and reason have their own words). */
export function requestIssue(issues: readonly { path: readonly PropertyKey[] }[]): TransferErrorKey {
  const field = issues[0]?.path[0];
  if (field === "price") return "price";
  if (field === "noPriceReason") return "reason";
  if (field === "priceExplanation" || field === "holdingReason") return "explanation";
  if (field === "buyerCode") return "code";
  if (field === "agreementSha256") return "agreement";
  if (field === "units") return "units";
  return "input";
}

/** SHA-256 of the agreement file as the database takes it: 64 lower-case hex digits, no 0x. */
export async function agreementSha256(data: ArrayBuffer | Uint8Array): Promise<string> {
  return (await sha256Hex(data)).slice(2);
}

/** stepup / enrolPasskey / session: the passkey gate of migration 0024 refused (webauth.gate). */
export type TransferErrorKey =
  | "input"
  | "rate"
  | "kyc"
  | "code"
  | "ownCode"
  | "codesMax"
  | "units"
  | "price"
  | "priceLimit"
  | "reason"
  | "agreement"
  | "explanation"
  | "closed"
  | "token"
  | "wallet"
  | "unknown"
  | "notAwaiting"
  | "mismatch"
  | "noWithdraw"
  | "generic"
  | "stepup"
  | "enrolPasskey"
  | "session";

/** The passkey gate's answer inside the webauth.web_transfer_* wrappers (as webauth.gate decides). */
export function gateError(r: { error?: unknown } | null | undefined): "stepup" | "enrolPasskey" | "session" | null {
  if (!r || r.error === undefined || r.error === null) return null;
  return r.error === "step_up" ? "stepup" : r.error === "enrol" ? "enrolPasskey" : "session";
}

/**
 * Maps a refusal raised by the database (SQLSTATE and message of the transfer.* functions, migration
 * 0028) to a message key. The database decides; this only picks friendly words. Unknown -> generic.
 */
export function transferErrorKey(code: string | undefined, message: string): TransferErrorKey {
  if (code === "42501") return "kyc";
  if (code === "P0002") {
    if (/receive code is unknown/.test(message)) return "code";
    if (/bound wallet/.test(message)) return "wallet";
    return "unknown";
  }
  if (code === "22003") return "units";
  if (code !== "23514") return "generic";
  if (/three receive codes/.test(message)) return "codesMax";
  if (/your own receive code|two different investors/.test(message)) return "ownCode";
  if (/units are a whole number/.test(message)) return "units";
  if (/needs a price per unit/.test(message)) return "price";
  if (/above the payment limit/.test(message)) return "priceLimit";
  if (/without consideration/.test(message)) return "reason";
  if (/fingerprint differs/.test(message)) return "mismatch";
  if (/SHA-256/.test(message)) return "agreement";
  if (/explanations are/.test(message)) return "explanation";
  if (/no active transfer.propose signing policy/.test(message)) return "closed";
  if (/token is not the one/.test(message)) return "token";
  if (/not waiting for your acceptance/.test(message)) return "notAwaiting";
  if (/can no longer be withdrawn/.test(message)) return "noWithdraw";
  if (/consideration must|court-ordered/.test(message)) return "input";
  return "generic";
}

// ---------------------------------------------------------------- the investor's list (transfer.web_list)

/** Investor-facing states (transfer.public_status): reasons and internal states are never shown (tipping-off). */
export const TRANSFER_STATES = ["under_review", "not_approved", "approved", "on_chain", "transferred", "completed", "being_cancelled", "refund_pending", "cancelled"] as const;
export type TransferState = (typeof TRANSFER_STATES)[number];
const isState = (s: unknown): s is TransferState => typeof s === "string" && (TRANSFER_STATES as readonly string[]).includes(s);

export interface TransferCase {
  id: string;
  role: "seller" | "buyer";
  status: TransferState;
  awaitingAcceptance: boolean;
  canAccept: boolean;
  canWithdraw: boolean;
  token: string;
  units: string;
  consideration: Consideration | "court_order";
  pricePaisa: string | null;
  totalPaisa: string | null;
  agreementSha256: string;
  openedAt: string;
  updatedAt: string;
  payment: { code: string; amountPaisa: string; payUntil: string; paid: boolean } | null;
  eta: string | null;
  executedAt: string | null;
  settlement: { grossPaisa: string; feePaisa: string; taxPaisa: string; netPaisa: string; reference: string | null; at: string | null } | null;
  refund: { amountPaisa: string; at: string | null } | null;
}

export interface TransferList {
  verified: boolean;
  codes: { code: string; expiresAt: string }[];
  holdings: { token: string; units: string }[];
  policyToken: string | null;
  cases: TransferCase[];
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null);
const field = (o: Obj, k: string): unknown => new Map(Object.entries(o)).get(k);
const str = (o: Obj, k: string): string | null => {
  const v = field(o, k);
  return typeof v === "string" ? v : null;
};
const digits = (o: Obj, k: string): string | null => {
  const v = field(o, k);
  const s = typeof v === "number" && Number.isSafeInteger(v) ? String(v) : typeof v === "string" ? v : null;
  return s !== null && /^-?[0-9]{1,20}$/.test(s) ? s : null;
};
const time = (o: Obj, k: string): string | null => {
  const s = str(o, k);
  return s !== null && !Number.isNaN(Date.parse(s)) ? s : null;
};
const arr = (o: Obj, k: string): unknown[] => {
  const v = field(o, k);
  return Array.isArray(v) ? v : [];
};

function toCase(v: unknown): TransferCase | null {
  const o = obj(v);
  if (!o) return null;
  const id = str(o, "id");
  const role = str(o, "role");
  const status = field(o, "status");
  const units = digits(o, "units");
  const token = str(o, "token");
  const consideration = str(o, "consideration");
  if (!id || !UUID.test(id) || (role !== "seller" && role !== "buyer") || !isState(status) || units === null || !token) return null;
  if (consideration !== "sale" && consideration !== "gift" && consideration !== "family" && consideration !== "court_order") return null;
  const p = obj(field(o, "payment"));
  const payment =
    p && str(p, "code") && digits(p, "amountPaisa") && time(p, "payUntil")
      ? { code: str(p, "code") ?? "", amountPaisa: digits(p, "amountPaisa") ?? "0", payUntil: time(p, "payUntil") ?? "", paid: field(p, "paid") === true }
      : null;
  const s = obj(field(o, "settlement"));
  const settlement =
    s && digits(s, "grossPaisa") !== null && digits(s, "netPaisa") !== null
      ? {
          grossPaisa: digits(s, "grossPaisa") ?? "0",
          feePaisa: digits(s, "feePaisa") ?? "0",
          taxPaisa: digits(s, "taxPaisa") ?? "0",
          netPaisa: digits(s, "netPaisa") ?? "0",
          reference: str(s, "reference"),
          at: time(s, "at"),
        }
      : null;
  const r = obj(field(o, "refund"));
  const refund = r && digits(r, "amountPaisa") !== null ? { amountPaisa: digits(r, "amountPaisa") ?? "0", at: time(r, "at") } : null;
  const sha = str(o, "agreementSha256") ?? "";
  return {
    id,
    role,
    status,
    awaitingAcceptance: field(o, "awaitingAcceptance") === true,
    canAccept: field(o, "canAccept") === true && role === "buyer",
    canWithdraw: field(o, "canWithdraw") === true,
    token,
    units,
    consideration,
    pricePaisa: digits(o, "pricePaisa"),
    totalPaisa: digits(o, "totalPaisa"),
    agreementSha256: SHA.test(sha) ? sha : "",
    openedAt: time(o, "openedAt") ?? "",
    updatedAt: time(o, "updatedAt") ?? "",
    // Payment instructions are the buyer's only; settlement the seller's; refund the buyer's.
    payment: role === "buyer" ? payment : null,
    eta: time(o, "eta"),
    executedAt: time(o, "executedAt"),
    settlement: role === "seller" ? settlement : null,
    refund: role === "buyer" ? refund : null,
  };
}

/** Copies webauth.web_transfers' JSON into the fixed shape above (unknown fields are dropped). */
export function parseTransferList(v: unknown): TransferList | null {
  const o = obj(v);
  if (!o) return null;
  const codes = arr(o, "codes")
    .map(obj)
    .filter((c): c is Obj => c !== null)
    .map((c) => ({ code: str(c, "code") ?? "", expiresAt: time(c, "expiresAt") ?? "" }))
    .filter((c) => RECEIVE_CODE.test(c.code) && c.expiresAt !== "");
  const holdings = arr(o, "holdings")
    .map(obj)
    .filter((h): h is Obj => h !== null)
    .map((h) => ({ token: (str(h, "token") ?? "").toLowerCase(), units: digits(h, "units") ?? "" }))
    .filter((h) => ADDRESS.test(h.token) && /^[1-9][0-9]*$/.test(h.units));
  const policy = (str(o, "policyToken") ?? "").toLowerCase();
  return {
    verified: field(o, "verified") === true,
    codes,
    holdings,
    policyToken: ADDRESS.test(policy) ? policy : null,
    cases: arr(o, "cases")
      .map(toCase)
      .filter((c): c is TransferCase => c !== null),
  };
}

/** Tokens the seller may pick: the ones held, and the token the transfer policy names when nothing is held yet. */
export function tokenChoices(list: Pick<TransferList, "holdings" | "policyToken">): { token: string; units: string | null; transferable: boolean }[] {
  const out: { token: string; units: string | null; transferable: boolean }[] = list.holdings.map((h) => ({ token: h.token, units: h.units, transferable: h.token === list.policyToken }));
  if (list.policyToken && !out.some((h) => h.token === list.policyToken)) out.push({ token: list.policyToken, units: null, transferable: true });
  return out.sort((a, b) => Number(b.transferable) - Number(a.transferable));
}

export type Tone = "ok" | "warn" | "bad" | "gray" | "cy";
export function transferTone(s: TransferState): Tone {
  if (s === "completed" || s === "transferred") return "ok";
  if (s === "under_review" || s === "approved" || s === "refund_pending" || s === "being_cancelled") return "warn";
  if (s === "not_approved") return "bad";
  if (s === "cancelled") return "gray";
  return "cy";
}

/** "0x1234…abcd" for a contract address or a fingerprint (the full value stays in the title attribute). */
export const shortHex = (h: string, head = 6, tail = 4): string => (h.length > head + tail + 1 ? `${h.slice(0, head)}…${h.slice(-tail)}` : h);
