import type { Lang } from "../../i18n";

/**
 * Display formatting for analyst facts (pure, no floats). Digits are always ASCII so the same figure
 * reads identically in English and Urdu answers, and citations can be checked mechanically.
 */

/** 1234567 → "1,234,567" (bigint-safe). */
export function groupDigits(n: bigint | number): string {
  const b = typeof n === "bigint" ? n : BigInt(Math.trunc(n));
  const neg = b < 0n;
  const s = (neg ? -b : b).toString();
  let out = "";
  for (let i = 0; i < s.length; i++) {
    if (i > 0 && (s.length - i) % 3 === 0) out += ",";
    out += s.charAt(i);
  }
  return neg ? `-${out}` : out;
}

/** Paisa as rupees: "PKR 1,234" or "PKR 1,234.50" (Urdu: "1,234 روپے"). Integer arithmetic only. */
export function formatPaisa(paisa: bigint, lang: Lang): string {
  const neg = paisa < 0n;
  const abs = neg ? -paisa : paisa;
  const rupees = abs / 100n;
  const rest = abs % 100n;
  const body = `${neg ? "-" : ""}${groupDigits(rupees)}${rest === 0n ? "" : `.${rest.toString().padStart(2, "0")}`}`;
  return lang === "ur" ? `${body} روپے` : `PKR ${body}`;
}

/** Basis points as a percentage with two decimals: 812 → "8.12%". */
export function formatBp(bp: number): string {
  const b = Math.max(0, Math.trunc(bp));
  return `${String(Math.floor(b / 100))}.${String(b % 100).padStart(2, "0")}%`;
}

const PKT_MS = 5 * 3_600_000;

/** ISO time → "2026-10-13 14:05 PKT" (Pakistan time, UTC+5, no daylight saving). */
export function formatPkt(iso: string | Date): string {
  const t = typeof iso === "string" ? Date.parse(iso) : iso.getTime();
  if (!Number.isFinite(t)) return "";
  const d = new Date(t + PKT_MS).toISOString();
  return `${d.slice(0, 10)} ${d.slice(11, 16)} PKT`;
}

/** ISO time → PKT calendar day "2026-10-13". */
export function formatPktDay(iso: string | Date): string {
  const t = typeof iso === "string" ? Date.parse(iso) : iso.getTime();
  if (!Number.isFinite(t)) return "";
  return new Date(t + PKT_MS).toISOString().slice(0, 10);
}
