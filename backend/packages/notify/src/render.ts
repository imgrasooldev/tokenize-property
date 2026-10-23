import { createHash } from "node:crypto";
import { EVENT_KINDS, isEventKind, wireParams, type Channel, type Locale, type PlaceholderType } from "./events.ts";

/**
 * Template rendering (ADR 0013). Templates are plain text with {{placeholder}} slots; values are
 * formatted per type and locale, stripped of control characters, isolated for right-to-left
 * Urdu, and escaped for HTML. SMS must fit SMS_MAX_SEGMENTS (GSM-7 or UCS-2 counting).
 */

export const SMS_MAX_SEGMENTS = 3;
/** Pakistan Standard Time is UTC+5 all year (no daylight saving). */
const PKT_OFFSET_MS = 5 * 60 * 60 * 1000;

export class RenderError extends Error {
  override name = "RenderError";
}

export interface TemplateInput {
  kind: string;
  channel: Channel;
  locale: Locale;
  subject: string | null;
  body: string;
  params: Readonly<Record<string, unknown>>;
}

export interface Rendered {
  subject?: string;
  text: string;
  html?: string;
  /** SMS only: number of segments the text needs. */
  segments?: number;
  /** SHA-256 of what is sent (stored as evidence instead of the text). */
  sha256: Buffer;
}

/** How each `word` placeholder value reads in English and Urdu (every catalogue choice has an entry; a test checks it). */
export const WORDS: Readonly<Record<string, Readonly<Record<Locale, string>>>> = {
  verified: { en: "verified", ur: "تصدیق شدہ" },
  expired: { en: "expired", ur: "میعاد ختم" },
  action_required: { en: "action required", ur: "کارروائی درکار" },
  closed: { en: "closed", ur: "بند" },
  sms: { en: "phone number", ur: "فون نمبر" },
  email: { en: "e-mail address", ur: "ای میل ایڈریس" },
  // officer.action_waiting queues and officer.alert topics (migration 0030).
  signing: { en: "A signing approval", ur: "دستخط کی منظوری" },
  trustee_cosign: { en: "A trustee co-signature", ur: "ٹرسٹی کی شریک منظوری" },
  offering_request: { en: "An offering approval", ur: "آفرنگ کی منظوری" },
  payout_release: { en: "A payout release request", ur: "ادائیگیاں بحال کرنے کی درخواست" },
  kyc_review: { en: "A KYC review", ur: "کے وائی سی جائزہ" },
  freeze_decision: { en: "An account hold decision", ur: "اکاؤنٹ روکنے کا فیصلہ" },
  compliance_case: { en: "A compliance case", ur: "کمپلائنس کیس" },
  distribution_approval: { en: "A rent distribution approval", ur: "کرایہ تقسیم کی منظوری" },
  trustee_precheck: { en: "A trustee pre-check", ur: "ٹرسٹی کی پیشگی جانچ" },
  distribution_review: { en: "A distribution review", ur: "تقسیم کا جائزہ" },
  // transfer.status_changed (migration 0028).
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
  exit_decision: { en: "An exit decision", ur: "اخراج کا فیصلہ" },
  transfer_review: { en: "A transfer review", ur: "منتقلی کا جائزہ" },
  vote_open: { en: "a vote of the holders is open", ur: "ہولڈرز کی ووٹنگ کھل گئی ہے" },
  sale_agreed: { en: "a sale agreement was signed", ur: "فروخت کا معاہدہ ہو گیا" },
  sale_completed: { en: "the sale was completed", ur: "فروخت مکمل ہو گئی" },
  sale_cancelled: { en: "the sale did not go ahead", ur: "فروخت نہیں ہو سکی" },
  payouts_paused: { en: "payouts paused by reconciliation", ur: "مفاہمت نے ادائیگیاں روک دیں" },
  payouts_resumed: { en: "payouts resumed", ur: "ادائیگیاں بحال" },
  passkey_clone: { en: "possible copied investor passkey", ur: "سرمایہ کار کی پاس کی کی ممکنہ نقل" },
  sla_breach: { en: "service level missed", ur: "مقررہ وقت گزر گیا" },
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (n: number): string => String(n).padStart(2, "0");

/** 2026-10-13T09:05:00Z -> "13 Oct 2026, 14:05 PKT" (en) or "13-10-2026 14:05 PKT" (ur). */
export function formatTime(iso: string, locale: Locale): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) throw new RenderError("invalid time");
  const d = new Date(t + PKT_OFFSET_MS);
  const hm = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  if (locale === "ur") return `${pad(d.getUTCDate())}-${pad(d.getUTCMonth() + 1)}-${String(d.getUTCFullYear())} ${hm} PKT`;
  return `${String(d.getUTCDate())} ${MONTHS[d.getUTCMonth()] ?? "?"} ${String(d.getUTCFullYear())}, ${hm} PKT`;
}

/** Paisa (integer) -> "PKR 1,234,567.89" (en) or "1,234,567.89 روپے" (ur). No floating point. */
export function formatPaisa(paisa: string, locale: Locale): string {
  if (!/^(0|[1-9][0-9]{0,17})$/.test(paisa)) throw new RenderError("invalid amount");
  const v = BigInt(paisa);
  const rupees = groupThousands((v / 100n).toString());
  const amount = `${rupees}.${(v % 100n).toString().padStart(2, "0")}`;
  return locale === "ur" ? `${amount} روپے` : `PKR ${amount}`;
}

/** "1234567" -> "1,234,567" (digits only, no regex backtracking). */
function groupThousands(digits: string): string {
  const parts: string[] = [];
  for (let end = digits.length; end > 0; end -= 3) parts.unshift(digits.slice(Math.max(0, end - 3), end));
  return parts.join(",");
}

function formatValue(type: PlaceholderType, value: string, locale: Locale): string {
  switch (type) {
    case "utc":
      return formatTime(value, locale);
    case "paisa":
      return formatPaisa(value, locale);
    case "count":
      if (!/^(0|[1-9][0-9]{0,17})$/.test(value)) throw new RenderError("invalid count");
      return groupThousands(value);
    case "word": {
      // eslint-disable-next-line security/detect-object-injection -- checked with hasOwn
      const w = Object.hasOwn(WORDS, value) ? WORDS[value] : undefined;
      // eslint-disable-next-line security/detect-object-injection -- locale is "en" | "ur"
      return w ? w[locale] : value;
    }
    case "last4":
    case "code":
    case "label":
      return value;
  }
}

// Left-to-right isolate (U+2066 ... U+2069): numbers, codes and Latin labels inside Urdu text keep
// their order and do not reorder the surrounding sentence.
const LRI = "\u2066";
const PDI = "\u2069";
const HAS_RTL = /[\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufeff]/;

/** Removes control characters (CR/LF would allow header injection in an e-mail subject). */
function clean(s: string): string {
  // eslint-disable-next-line no-control-regex -- removing control characters is the point
  return s.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
}

function fill(template: string, values: Readonly<Record<string, string>>, locale: Locale, singleLine: boolean): string {
  const out = template.replace(/\{\{([a-z_0-9]+)\}\}/g, (_m, name: string) => {
    if (!Object.hasOwn(values, name)) throw new RenderError(`template uses {{${name}}}, which the event does not have`);
    // eslint-disable-next-line security/detect-object-injection -- checked with hasOwn
    const v = clean(values[name] ?? "");
    return locale === "ur" && !HAS_RTL.test(v) ? `${LRI}${v}${PDI}` : v;
  });
  if (/\{\{|\}\}/.test(out)) throw new RenderError("template has a malformed placeholder");
  return singleLine ? out.replace(/[\r\n]+/g, " ").trim() : out;
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// GSM 03.38 default alphabet and its extension table (extension characters count as two septets).
const GSM_BASIC = new Set(
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà",
);
const GSM_EXT = new Set("^{}\\[~]|€\f");

/** Number of SMS segments: GSM-7 160/153 septets, otherwise UCS-2 70/67 UTF-16 units. */
export function smsSegments(text: string): { encoding: "gsm7" | "ucs2"; units: number; segments: number } {
  let septets = 0;
  let gsm = true;
  for (const ch of text) {
    if (GSM_BASIC.has(ch)) septets += 1;
    else if (GSM_EXT.has(ch)) septets += 2;
    else {
      gsm = false;
      break;
    }
  }
  if (gsm) return { encoding: "gsm7", units: septets, segments: septets === 0 ? 1 : septets <= 160 ? 1 : Math.ceil(septets / 153) };
  const units = text.length; // UTF-16 code units, as UCS-2/UTF-16 SMS counts them
  return { encoding: "ucs2", units, segments: units <= 70 ? 1 : Math.ceil(units / 67) };
}

/** Renders one message. Throws RenderError (permanent: the delivery goes to the dead letters). */
export function render(t: TemplateInput): Rendered {
  if (!isEventKind(t.kind)) throw new RenderError(`unknown event kind ${t.kind}`);
  let wire: Record<string, string>;
  try {
    wire = wireParams(t.kind, t.params);
  } catch (e) {
    throw new RenderError((e as Error).message);
  }
  const spec = EVENT_KINDS[t.kind].placeholders as Readonly<Record<string, { type: PlaceholderType }>>;
  const values: Record<string, string> = {};
  for (const [name, v] of Object.entries(wire)) {
    // eslint-disable-next-line security/detect-object-injection -- checked with hasOwn
    const p = Object.hasOwn(spec, name) ? spec[name] : undefined;
    if (!p) throw new RenderError(`unknown parameter ${name}`);
    // eslint-disable-next-line security/detect-object-injection -- names come from the catalogue
    values[name] = formatValue(p.type, v, t.locale);
  }

  if (t.channel === "sms" || t.channel === "push") {
    const text = fill(t.body, values, t.locale, true);
    if (t.channel === "push") return { text, sha256: digest(text) };
    const s = smsSegments(text);
    if (s.segments > SMS_MAX_SEGMENTS) {
      throw new RenderError(`SMS needs ${String(s.segments)} segments (${s.encoding}, ${String(s.units)} units); the limit is ${String(SMS_MAX_SEGMENTS)}`);
    }
    return { text, segments: s.segments, sha256: digest(text) };
  }

  if (t.subject === null) throw new RenderError("an e-mail template needs a subject");
  const subject = fill(t.subject, values, t.locale, true).slice(0, 200);
  const text = fill(t.body, values, t.locale, false);
  const dir = t.locale === "ur" ? "rtl" : "ltr";
  const paragraphs = text
    .split(/\n{2,}/)
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br>")}</p>`)
    .join("\n");
  const html = `<!doctype html>\n<html lang="${t.locale}" dir="${dir}"><head><meta charset="utf-8"><title>${escapeHtml(subject)}</title></head>\n<body><div lang="${t.locale}" dir="${dir}">\n${paragraphs}\n</div></body></html>`;
  return { subject, text, html, sha256: digest(`${subject}\n${text}\n${html}`) };
}

function digest(s: string): Buffer {
  return createHash("sha256").update(s, "utf8").digest();
}
