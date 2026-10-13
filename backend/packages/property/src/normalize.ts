/**
 * Pure rules of S-01 mirrored from migration 0014 (the database is authoritative; these give the
 * portal a preview and let tests compare both implementations).
 */

const ASCII_LOWER = "abcdefghijklmnopqrstuvwxyz";
const DIGIT_FROM = "۰۱۲۳۴۵۶۷۸۹٠١٢٣٤٥٦٧٨٩";
const LETTER_FROM = "يىكه";
const LETTER_TO = "ییکہ";
const MARK = "";

function translate(s: string): string {
  let out = "";
  for (const ch of s) {
    const lower = ASCII_LOWER.indexOf(ch);
    if (lower >= 0) {
      out += ch.toUpperCase();
      continue;
    }
    const digit = DIGIT_FROM.indexOf(ch);
    if (digit >= 0) {
      out += String(digit % 10);
      continue;
    }
    const letter = LETTER_FROM.indexOf(ch);
    out += letter >= 0 ? LETTER_TO.charAt(letter) : ch;
  }
  return out;
}

/**
 * OB-11 identifier normalisation, identical to property.norm(): NFKC; Urdu and Arabic-Indic digits
 * to 0-9; Arabic yeh, alef maksura, kaf and heh to their Urdu forms; a-z to A-Z; a run of separators
 * between two digits becomes '/' (khasra 123/4 is not 1234); every other character that is not A-Z,
 * 0-9 or an Arabic-script letter is removed; leading zeros of a digit run are dropped.
 */
export function normIdentifier(input: string | null | undefined): string {
  const s = translate((input ?? "").normalize("NFKC"))
    .replace(/([0-9])[ \t\n\r\f\v]*[-/‐-―−]+[ \t\n\r\f\v]*(?=[0-9])/g, `$1${MARK}`)
    .replace(/[^A-Z0-9ء-غف-يٱ-ۓە]/g, "")
    .replaceAll(MARK, "/");
  return s.replace(/(^|[^0-9])0+(?=[0-9])/g, "$1");
}

export const PROVINCES = ["punjab", "sindh", "kp", "balochistan", "ict", "gb", "ajk"] as const;
export type Province = (typeof PROVINCES)[number];

export interface KeyParts {
  province?: Province | null;
  district?: string | null;
  mauza?: string | null;
  society?: string | null;
  khewat?: string | null;
  khasra?: string | null;
  plot_no?: string | null;
  building?: string | null;
  floor?: string | null;
  unit_no?: string | null;
}

/** OB-11 property key, identical to property.make_key(); null while incomplete. */
export function propertyKey(p: KeyParts): string | null {
  const n = normIdentifier;
  if (!p.province || n(p.district) === "") return null;
  const unit = `${n(p.building)}:${n(p.floor)}:${n(p.unit_no)}`;
  if (n(p.plot_no) !== "" && n(p.society) !== "") {
    return `${p.province}|${n(p.district)}|S:${n(p.society)}|P:${n(p.plot_no)}|${unit}`;
  }
  if (n(p.khasra) !== "" && n(p.mauza) !== "") {
    return `${p.province}|${n(p.district)}|M:${n(p.mauza)}|K:${n(p.khewat)}-${n(p.khasra)}|${unit}`;
  }
  return null;
}

/** Great-circle distance in metres, as property.distance_m(). */
export function distanceM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const rad = (d: number): number => (d * Math.PI) / 180;
  const a = Math.sin(rad(lat2 - lat1) / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lon2 - lon1) / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.sqrt(a));
}

export interface ValuationInput {
  valuer: string;
  valuePaisa: bigint;
  /** Valuation date as YYYY-MM-DD. */
  valuedOn: string;
}

export interface ValuationRules {
  toleranceBp: bigint;
  gapDays: number;
}

/**
 * OB-25/OB-26 for the latest valid valuation of every valuer: two within the tolerance of the lower
 * one (exactly 10 % passes) and within the gap; three or more go to the committee; the offering value
 * is capped at the lowest. Mirrors property.valuation_status() after its validity filter.
 */
export function valuationOutcome(vals: ValuationInput[], rules: ValuationRules): { ok: boolean; problem: string | null; lowestPaisa: bigint | null } {
  const latest = new Map<string, ValuationInput>();
  for (const v of vals) latest.set(v.valuer, v);
  const list = [...latest.values()];
  const lowest = list.length ? list.reduce((m, v) => (v.valuePaisa < m ? v.valuePaisa : m), list[0]?.valuePaisa ?? 0n) : null;
  if (list.length < 2 || lowest === null) return { ok: false, problem: "two independent, valid valuations are required", lowestPaisa: lowest };
  if (list.length === 2) {
    const [a, b] = list as [ValuationInput, ValuationInput];
    const hi = a.valuePaisa > b.valuePaisa ? a.valuePaisa : b.valuePaisa;
    if ((hi - lowest) * 10_000n > rules.toleranceBp * lowest) return { ok: false, problem: "third valuation required", lowestPaisa: lowest };
    const days = Math.abs(Date.parse(`${a.valuedOn}T00:00:00Z`) - Date.parse(`${b.valuedOn}T00:00:00Z`)) / 86_400_000;
    if (days > rules.gapDays) return { ok: false, problem: "valuations too far apart in time", lowestPaisa: lowest };
  }
  return { ok: true, problem: null, lowestPaisa: lowest };
}

export interface Vote {
  independent: boolean;
  conflict: boolean;
  vote: "approve" | "reject" | "abstain" | null;
}

/** OB-33, as property.ic_outcome(): quorum of non-conflicted votes with an independent member; majority approve; no independent against. */
export function icOutcome(votes: Vote[], quorum: number): { quorum: boolean; approved: boolean } {
  const counted = votes.filter((v) => !v.conflict && v.vote !== null);
  const hasQuorum = counted.length >= quorum && counted.some((v) => v.independent);
  const approvals = counted.filter((v) => v.vote === "approve").length;
  const independentAgainst = counted.some((v) => v.independent && v.vote === "reject");
  return { quorum: hasQuorum, approved: hasQuorum && approvals * 2 > counted.length && !independentAgainst };
}
