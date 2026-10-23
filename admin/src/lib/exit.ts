/**
 * S-05 exit (migration 0027): pure helpers shared by the pages and the API routes. Nothing here
 * touches the database; the database validates everything again (exit.normalize_detail and the
 * exit.* functions), these checks only give the officer an early, specific message.
 */

export const EXIT_HEX32 = /^[0-9a-f]{64}$/;
export const EXIT_ADDRESS = /^0x[0-9a-f]{40}$/;
const UNITS = /^(0|[1-9]\d{0,30})$/;
const BLOCK = /^(0|[1-9]\d{0,17})$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const BUYER_REF = /^[A-Za-z0-9][A-Za-z0-9:._-]{2,63}$/;
const WHOLE = /^\d{1,15}$/;
const FRACTION = /^\d{1,2}$/;

/**
 * An amount typed in rupees ("1,234,500.5", "Rs 100") as integer paisa, without floating point.
 * Returns null for anything else (negative, more than two decimals, letters).
 */
export function paisaFromRupees(input: string | null | undefined): string | null {
  if (typeof input !== "string") return null;
  const t = input.trim().replace(/^(rs\.?|pkr)\s*/i, "").replace(/,/g, "");
  const parts = t.split(".");
  const w = parts[0] ?? "";
  const f = parts[1] ?? "";
  if (parts.length > 2 || !WHOLE.test(w) || (parts.length === 2 && !FRACTION.test(f))) return null;
  return (BigInt(w) * 100n + BigInt(f.padEnd(2, "0"))).toString();
}

/**
 * A Pakistan time from <input type="datetime-local"> ("2026-10-22T14:30", PKT = UTC+5, no daylight
 * saving) as an ISO UTC instant; null for anything else.
 */
export function pktLocalToUtc(v: string | null | undefined): string | null {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(v)) return null;
  const t = Date.parse(`${v}:00+05:00`);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

export type FieldKind = "sha" | "block" | "units" | "rupees" | "rupees0" | "date" | "bool" | "confirm" | "buyerRef" | "depositTreatment" | "wallet";

export interface DetailField {
  key: string;
  kind: FieldKind;
  label: string;
}

const sha = (key: string, label: string): DetailField => ({ key, kind: "sha", label: `${label} (SHA-256)` });

/** The detail each decision code carries (as exit.normalize_detail stores it). */
export const DECISION_FIELDS: Readonly<Record<string, readonly DetailField[]>> = {
  X1: [sha("minutesSha", "Committee minutes")],
  X2: [
    sha("minutesSha", "Committee minutes"),
    sha("noticeSha", "Vote notice sent to investors"),
    { key: "voteRecordBlock", kind: "block", label: "Vote record block (already indexed)" },
  ],
  X3: [sha("minutesSha", "Committee minutes")],
  X4: [
    sha("ballotsSha", "Scrutineer's counted ballots"),
    { key: "eligibleUnits", kind: "units", label: "Eligible units (supply at the vote record block)" },
    { key: "votesFor", kind: "units", label: "Units for" },
    { key: "votesAgainst", kind: "units", label: "Units against" },
    { key: "votesAbstain", kind: "units", label: "Units abstaining" },
    { key: "lowerPriceApproved", kind: "bool", label: "The vote approved a price below the lower valuation" },
  ],
  X6: [sha("legalAdviceSha", "Legal advice")],
  X7: [sha("legalAdviceSha", "Legal advice"), { key: "conflictsCleared", kind: "confirm", label: "Related parties are excluded (EX-SOD-2)" }],
  X8: [sha("buyerChecksSha", "Buyer checks"), { key: "buyerRef", kind: "buyerRef", label: "Buyer's KYB/KYC case reference (no personal data)" }],
  X9: [
    sha("buyerChecksSha", "Buyer checks"),
    sha("agreementSha", "Signed sale agreement"),
    { key: "buyerRef", kind: "buyerRef", label: "Buyer's KYB/KYC case reference (no personal data)" },
    { key: "salePricePaisa", kind: "rupees", label: "Sale price (PKR)" },
    { key: "depositPaisa", kind: "rupees0", label: "Deposit (PKR, may be 0)" },
    { key: "cpDeadline", kind: "date", label: "Condition-precedent deadline" },
  ],
  X10: [
    sha("evidenceSha", "Default / failed condition evidence"),
    { key: "depositTreatment", kind: "depositTreatment", label: "Deposit treatment per the agreement" },
  ],
  X11: [sha("deedSha", "Registered sale deed")],
  X12: [],
  X18: [sha("finalAccountsSha", "Final accounts"), sha("windupSha", "Trust wind-up evidence")],
  HR: [{ key: "wallet", kind: "wallet", label: "Held wallet of the redemption batch" }],
};
// X5 records the same count as X4.
export const DECISION_CODES = ["X1", "X2", "X3", "X4", "X5", "X6", "X7", "X8", "X9", "X10", "X11", "X12", "X18", "HR"] as const;

export function fieldsOf(code: string): readonly DetailField[] {
  const key = code === "X5" ? "X4" : code;
  return new Map(Object.entries(DECISION_FIELDS)).get(key) ?? [];
}

export function isDecisionCode(x: unknown): x is (typeof DECISION_CODES)[number] {
  return typeof x === "string" && (DECISION_CODES as readonly string[]).includes(x);
}

/**
 * The decision detail from a form (field names = detail keys): the JSON object the database
 * expects, or a message naming the first bad field.
 */
export function buildDetail(code: string, get: (key: string) => string | null): Record<string, string | boolean> | string {
  if (!isDecisionCode(code)) return "Choose a decision.";
  const out: Record<string, string | boolean> = {};
  for (const f of fieldsOf(code)) {
    const raw = get(f.key)?.trim() ?? "";
    let v: string | boolean | null = null;
    switch (f.kind) {
      case "sha":
        v = EXIT_HEX32.test(raw.toLowerCase()) ? raw.toLowerCase() : null;
        break;
      case "block":
        v = BLOCK.test(raw) ? raw : null;
        break;
      case "units":
        v = UNITS.test(raw) ? raw : null;
        break;
      case "rupees": {
        const p = paisaFromRupees(raw);
        v = p !== null && p !== "0" ? p : null;
        break;
      }
      case "rupees0":
        v = paisaFromRupees(raw);
        break;
      case "date":
        v = DATE.test(raw) && Number.isFinite(Date.parse(`${raw}T00:00:00Z`)) ? raw : null;
        break;
      case "bool":
        v = raw === "true" ? true : raw === "false" ? false : null;
        break;
      case "confirm":
        v = raw === "true" ? true : null;
        break;
      case "buyerRef":
        v = BUYER_REF.test(raw) ? raw : null;
        break;
      case "depositTreatment":
        v = raw === "forfeit" || raw === "refund" || raw === "none" ? raw : null;
        break;
      case "wallet":
        v = EXIT_ADDRESS.test(raw.toLowerCase()) ? raw.toLowerCase() : null;
        break;
    }
    if (v === null) return `${f.label}: missing or not valid.`;
    out[f.key] = v;
  }
  return out;
}

/** Labels for exit case states (spec S-05 section 3). */
const STATE_LABEL = new Map<string, string>([
  ["proposed", "Proposed"],
  ["vote_open", "Investor vote open"],
  ["trustee_review", "Trustee review"],
  ["buyer_dd", "Buyer due diligence"],
  ["contracted", "Contracted"],
  ["completed_sale", "Sale completed"],
  ["waterfall", "Waterfall"],
  ["final_published", "Final distribution published"],
  ["final_finalized", "Final distribution finalized"],
  ["redeeming", "Redeeming"],
  ["paid_out", "Paid out"],
  ["closed", "Closed"],
  ["rejected", "Rejected"],
  ["sale_collapsed", "Sale collapsed"],
]);
export function exitStateLabel(s: string): string {
  return STATE_LABEL.get(s) ?? s;
}

const CAPACITY_LABEL = new Map<string, string>([
  ["ops_checker", "Operations checker"],
  ["compliance_officer", "Compliance officer"],
  ["legal_officer", "Legal officer"],
  ["trustee_officer", "Trustee officer"],
]);
export function exitCapacityLabel(c: string): string {
  return CAPACITY_LABEL.get(c) ?? c;
}

/** Chip class for a case, decision, record or line status. */
export function exitChip(s: string | null | undefined): string {
  if (!s) return "chip";
  if (["closed", "approved", "booked", "paid", "confirmed", "recorded", "executed", "nothing_to_pay", "paid_out", "checked"].includes(s)) return "chip ok";
  if (["rejected", "returned", "sale_collapsed", "failed", "review", "declined", "held"].includes(s)) return "chip bad";
  return "chip warn";
}

export const LINE_KINDS = [
  ["secured_debt", "Secured debt (payee)"],
  ["transaction_cost", "Transaction cost (payee)"],
  ["sale_tax", "Sale tax"],
  ["payable", "Payable (payee)"],
  ["tenant_deposit", "Tenant deposit (payee)"],
  ["closure_reserve", "Closure reserve"],
  ["reserve_release", "Inflow: reserve release"],
  ["rent_transfer", "Inflow: undistributed rent"],
] as const;
export const LINE_KIND_CODES: readonly string[] = LINE_KINDS.map(([k]) => k);
export const PAYEE_KINDS: readonly string[] = ["secured_debt", "transaction_cost", "payable", "tenant_deposit"];
export const PAYEE = /^[a-z0-9][a-z0-9_-]{1,39}$/;
