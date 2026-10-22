import type { Lang } from "../i18n";
import { aLabel, analystDict, type AnalystDict } from "../i18n-analyst";
import { label as offeringLabel, offeringDict } from "../i18n-offering";
import { hasWord, normalizeText } from "./analyst/normalize";
import type { CatalogEntry, CatalogStatus } from "./catalog";

/**
 * Site search (ADR 0015), pure: ranks catalogue entries and a few static pages for a query.
 * Case- and diacritic-insensitive, Urdu script supported (see normalizeText). Exact symbol first,
 * then name, then place (district, city, province), then property type and status words.
 */

export const MAX_QUERY = 80;

export type SearchField = "symbol" | "name" | "district" | "city" | "province" | "use" | "status" | "page";

export interface SearchResult {
  kind: "property" | "page";
  key: string;
  href: string;
  title: string;
  subtitle: string;
  matched: SearchField;
  score: number;
  status?: CatalogStatus;
}

export type SearchOutcome = { ok: true; query: string; results: SearchResult[] } | { ok: false; reason: "empty" | "tooLong" };

const WEIGHT: Record<SearchField, number> = { symbol: 100, name: 50, district: 30, city: 28, province: 25, use: 15, status: 10, page: 20 };

const STOP = new Set(
  [
    "a", "an", "the", "is", "are", "was", "of", "in", "on", "for", "to", "and", "or", "what", "which", "how", "much", "many", "does", "do", "did",
    "it", "its", "this", "that", "me", "my", "i", "about", "show", "tell", "please", "with", "has", "have", "per",
    "kya", "hai", "hain", "ka", "ki", "ke", "ko", "se", "mein", "main", "aur", "kitna", "kitni", "kitne",
    "کیا", "ہے", "ہیں", "کا", "کی", "کے", "کو", "سے", "میں", "اور", "کتنا", "کتنی", "کتنے", "یہ", "وہ", "اس",
  ].map((w) => normalizeText(w)),
);

/** Words in generated offering names that do not identify one property. */
const GENERIC = new Set(["commercial", "residential", "mixed", "use", "property", "floor", "pakistan", "کمرشل", "رہائشی", "مخلوط", "استعمال", "جائیداد", "منزل"].map((w) => normalizeText(w)));

interface Field {
  field: SearchField;
  text: string;
}

function scoreFields(fields: Field[], q: string, tokens: string[]): { score: number; matched: SearchField } | null {
  let best: { score: number; matched: SearchField } | null = null;
  let extra = 0;
  for (const f of fields) {
    if (f.text.length === 0) continue;
    const w = WEIGHT[f.field];
    let s = 0;
    if (f.text === q) s = w * 1.2;
    else if (hasWord(f.text, q)) s = w;
    else if (tokens.length > 0) {
      const hit = tokens.filter((t) => hasWord(f.text, t)).length;
      if (hit > 0) s = (w * 0.7 * hit) / tokens.length;
    }
    if (s <= 0) continue;
    extra += 1;
    if (!best || s > best.score) best = { score: s, matched: f.field };
  }
  return best ? { score: Math.round(best.score + extra), matched: best.matched } : null;
}

function entryFields(e: CatalogEntry): Field[] {
  const n = normalizeText;
  const fields: Field[] = [];
  if (e.symbol) fields.push({ field: "symbol", text: n(e.symbol) });
  fields.push({ field: "name", text: n(e.name.en) }, { field: "name", text: n(e.name.ur) });
  if (e.district) fields.push({ field: "district", text: n(e.district) });
  if (e.city) fields.push({ field: "city", text: n(e.city.en) }, { field: "city", text: n(e.city.ur) });
  if (e.province) {
    fields.push(
      { field: "province", text: n(e.province) },
      { field: "province", text: n(offeringLabel(offeringDict("en"), "province_", e.province, "")) },
      { field: "province", text: n(offeringLabel(offeringDict("ur"), "province_", e.province, "")) },
    );
  }
  if (e.use) {
    fields.push({ field: "use", text: n(aLabel(analystDict("en"), `use_${e.use}`, e.use)) }, { field: "use", text: n(aLabel(analystDict("ur"), `use_${e.use}`, e.use)) });
  }
  fields.push({ field: "status", text: n(aLabel(analystDict("en"), `st_${e.status}`, e.status)) }, { field: "status", text: n(aLabel(analystDict("ur"), `st_${e.status}`, e.status)) });
  return fields;
}

interface Page {
  key: string;
  href: string;
  title: keyof AnalystDict;
  desc: keyof AnalystDict;
  words: string[];
}

const PAGES: Page[] = [
  { key: "verify", href: "/verify", title: "page_verify", desc: "page_verify_d", words: ["verify", "proof", "hash", "merkle", "tasdeeq", "تصدیق", "ثبوت"] },
  { key: "offerings", href: "/offerings", title: "page_offerings", desc: "page_offerings_d", words: ["offering", "subscribe", "ipo", "aafring", "آفرنگ", "پیشکش"] },
  { key: "market", href: "/market", title: "page_market", desc: "page_market_d", words: ["market", "trade", "buy", "sell", "order", "bazaar", "مارکیٹ", "خرید", "فروخت"] },
  { key: "portfolio", href: "/portfolio", title: "page_portfolio", desc: "page_portfolio_d", words: ["portfolio", "holdings", "my tokens", "پورٹ فولیو"] },
  { key: "how", href: "/#how", title: "page_how", desc: "page_how_d", words: ["how it works", "how does it work", "kaise", "کیسے", "طریقہ"] },
  { key: "properties", href: "/properties", title: "page_properties", desc: "page_properties_d", words: ["properties", "property", "jaidad", "جائیداد", "جائیدادیں"] },
];

function pageFields(p: Page): Field[] {
  const en = analystDict("en");
  const ur = analystDict("ur");
  const n = normalizeText;
  const fields: Field[] = [
    { field: "page", text: n(en[p.title]) },
    { field: "page", text: n(ur[p.title]) },
    ...p.words.map((w) => ({ field: "page" as const, text: n(w) })),
  ];
  return fields;
}

/**
 * Ranked results for `q` over the catalogue `entries` plus the static pages. Pure: the caller passes
 * the catalogue (search page: `catalog().entries`).
 */
export function searchCatalog(q: string, lang: Lang, entries: readonly CatalogEntry[]): SearchOutcome {
  const raw = q.trim();
  if (raw.length > MAX_QUERY) return { ok: false, reason: "tooLong" };
  const query = normalizeText(raw);
  if (query.length === 0) return { ok: false, reason: "empty" };
  const tokens = query.split(" ").filter((t) => t.length > 1 && !STOP.has(t));
  const d = analystDict(lang);
  const results: SearchResult[] = [];
  for (const e of entries) {
    const s = scoreFields(entryFields(e), query, tokens);
    if (!s || s.score < 8) continue;
    const place = [e.district, e.city ? (lang === "ur" ? e.city.ur : e.city.en) : null].filter((x, i, a): x is string => x !== null && a.indexOf(x) === i).join(", ");
    const status = aLabel(d, `st_${e.status}`, e.status);
    results.push({
      kind: "property",
      key: e.key,
      href: e.href,
      title: lang === "ur" ? e.name.ur : e.name.en,
      subtitle: [e.symbol, place, status].filter(Boolean).join(" · "),
      matched: s.matched,
      score: s.score,
      status: e.status,
    });
  }
  for (const p of PAGES) {
    const s = scoreFields(pageFields(p), query, tokens);
    if (!s || s.score < 8) continue;
    results.push({ kind: "page", key: p.key, href: p.href, title: d[p.title], subtitle: d[p.desc], matched: "page", score: s.score });
  }
  results.sort((a, b) => b.score - a.score || (a.kind === b.kind ? a.title.localeCompare(b.title) : a.kind === "property" ? -1 : 1));
  return { ok: true, query: raw, results };
}

/** Catalogue entries a question mentions by symbol or name (strong matches only). */
export function entriesMentioned(q: string, entries: readonly CatalogEntry[]): CatalogEntry[] {
  const query = normalizeText(q.slice(0, 300));
  if (query.length === 0) return [];
  const tokens = query.split(" ").filter((t) => t.length > 2 && !STOP.has(t));
  return entries.filter((e) => {
    if (e.symbol && tokens.includes(normalizeText(e.symbol))) return true;
    for (const name of [e.name.en, e.name.ur]) {
      const words = normalizeText(name)
        .split(" ")
        .filter((w) => w.length > 2 && !STOP.has(w) && !GENERIC.has(w));
      const hits = words.filter((w) => tokens.includes(w)).length;
      if (hits > 0 && (hits * 2 >= words.length || (words[0] !== undefined && tokens.includes(words[0])))) return true;
    }
    return false;
  });
}
