import type { Lang } from "./i18n";

/**
 * Renders an in-app notification (T-028, migration 0030 NP-8) from the e-mail template in the
 * reader's language and the notification's typed values, exactly as the backend renderer does for
 * e-mail (`backend/packages/notify/src/render.ts`): times in PKT, money from paisa without floating
 * point, fixed words translated, left-to-right values isolated inside Urdu. Plain text only: React
 * escapes it, and no template carries links.
 */
export type PlaceholderType = "utc" | "paisa" | "count" | "last4" | "code" | "label" | "word";

/** The words a `word` placeholder can carry (mirrors the backend's WORDS; a test keeps them equal). */
export const NOTIFY_WORDS: Readonly<Record<string, Readonly<Record<Lang, string>>>> = {
  verified: { en: "verified", ur: "تصدیق شدہ" },
  expired: { en: "expired", ur: "میعاد ختم" },
  action_required: { en: "action required", ur: "کارروائی درکار" },
  closed: { en: "closed", ur: "بند" },
  sms: { en: "phone number", ur: "فون نمبر" },
  email: { en: "e-mail address", ur: "ای میل ایڈریس" },
  accepted: { en: "accepted", ur: "قبول" },
  under_review: { en: "under review", ur: "زیرِ جائزہ" },
  not_approved: { en: "not approved", ur: "منظور نہیں ہوئی" },
  approved: { en: "approved", ur: "منظور" },
  payment_received: { en: "payment received", ur: "ادائیگی موصول" },
  on_chain: { en: "being recorded on chain", ur: "آن چین درج ہو رہی ہے" },
  transferred: { en: "transferred", ur: "منتقل ہو گئی" },
  completed: { en: "completed", ur: "مکمل" },
  being_cancelled: { en: "being cancelled", ur: "منسوخ کی جا رہی ہے" },
  refund_pending: { en: "refund pending", ur: "رقم کی واپسی زیرِ عمل" },
  refunded: { en: "refunded", ur: "رقم واپس" },
  cancelled: { en: "cancelled", ur: "منسوخ" },
  vote_open: { en: "a vote of the holders is open", ur: "ہولڈرز کی ووٹنگ کھل گئی ہے" },
  sale_agreed: { en: "a sale agreement was signed", ur: "فروخت کا معاہدہ ہو گیا" },
  sale_completed: { en: "the sale was completed", ur: "فروخت مکمل ہو گئی" },
  sale_cancelled: { en: "the sale did not go ahead", ur: "فروخت نہیں ہو سکی" },
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (n: number): string => String(n).padStart(2, "0");
const LRI = "\u2066";
const PDI = "\u2069";
const HAS_RTL = /[\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufeff]/;

/** 2026-10-13T09:05:00Z -> "13 Oct 2026, 14:05 PKT" (en) or "13-10-2026 14:05 PKT" (ur). */
export function notifyTime(iso: string, lang: Lang): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  const d = new Date(t + 5 * 3_600_000);
  const hm = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  if (lang === "ur") return `${pad(d.getUTCDate())}-${pad(d.getUTCMonth() + 1)}-${String(d.getUTCFullYear())} ${hm} PKT`;
  return `${String(d.getUTCDate())} ${MONTHS[d.getUTCMonth()] ?? "?"} ${String(d.getUTCFullYear())}, ${hm} PKT`;
}

function group(digits: string): string {
  const parts: string[] = [];
  for (let end = digits.length; end > 0; end -= 3) parts.unshift(digits.slice(Math.max(0, end - 3), end));
  return parts.join(",");
}

/** Paisa -> "PKR 1,234,567.89" (en) or "1,234,567.89 روپے" (ur). */
export function notifyPaisa(paisa: string, lang: Lang): string {
  if (!/^(0|[1-9][0-9]{0,17})$/.test(paisa)) return "—";
  const v = BigInt(paisa);
  const amount = `${group((v / 100n).toString())}.${(v % 100n).toString().padStart(2, "0")}`;
  return lang === "ur" ? `${amount} روپے` : `PKR ${amount}`;
}

function value(type: PlaceholderType | undefined, raw: string, lang: Lang): string {
  switch (type) {
    case "utc":
      return notifyTime(raw, lang);
    case "paisa":
      return notifyPaisa(raw, lang);
    case "count":
      return /^(0|[1-9][0-9]{0,17})$/.test(raw) ? group(raw) : "—";
    case "word": {
      // eslint-disable-next-line security/detect-object-injection -- checked with hasOwn; lang is "en" | "ur"
      return Object.hasOwn(NOTIFY_WORDS, raw) ? (NOTIFY_WORDS[raw]?.[lang] ?? raw) : raw;
    }
    default:
      return raw;
  }
}

function fill(template: string, params: Readonly<Record<string, string>>, specs: Readonly<Record<string, { type: PlaceholderType }>>, lang: Lang): string {
  return template.replace(/\{\{([a-z_0-9]+)\}\}/g, (_m, name: string) => {
    if (!Object.hasOwn(params, name)) return "—";
    // eslint-disable-next-line security/detect-object-injection, no-control-regex -- checked with hasOwn; removing control characters is the point
    const raw = (params[name] ?? "").replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
    // eslint-disable-next-line security/detect-object-injection -- names come from the template, checked above
    const v = value(Object.hasOwn(specs, name) ? specs[name]?.type : undefined, raw, lang);
    return lang === "ur" && !HAS_RTL.test(v) ? `${LRI}${v}${PDI}` : v;
  });
}

export interface RenderedNotice {
  title: string;
  paragraphs: string[];
}

/** One notification as the investor reads it in the app. Without a template the kind is shown. */
export function renderNotice(
  n: { kind: string; subject: string | null; body: string | null; params: Readonly<Record<string, string>>; placeholders: Readonly<Record<string, { type: PlaceholderType }>> },
  lang: Lang,
): RenderedNotice {
  if (!n.body) return { title: n.kind, paragraphs: [] };
  const title = fill(n.subject ?? n.kind, n.params, n.placeholders, lang).replace(/[\r\n]+/g, " ").trim();
  const paragraphs = fill(n.body, n.params, n.placeholders, lang)
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  return { title, paragraphs };
}
