import type { Lang } from "../../../i18n";
import { analystDict, analystSuggestions, type AnalystDict } from "../../../i18n-analyst";
import type { Answer, CitedFact, Fact, Intent, Question, Retrieved, Source } from "../types";

/**
 * Grounded provider (default, no external service): composes the answer deterministically from the
 * retrieved facts. Its own sentences carry no figures; every figure is a fact value cited as [n].
 */

export function citedFacts(facts: Fact[], lang: Lang): CitedFact[] {
  return facts.map((f, i) => ({ n: i + 1, id: f.id, text: lang === "ur" ? (f.textUr ?? f.text) : f.text, value: f.value, source: f.source }));
}

export function distinctSources(facts: CitedFact[]): Source[] {
  const seen = new Set<string>();
  const out: Source[] = [];
  for (const f of facts) {
    const k = `${f.source.kind}|${f.source.ref}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(f.source);
  }
  return out;
}

function intro(intent: Intent, d: AnalystDict): string {
  switch (intent) {
    case "yield":
      return d.intro_yield;
    case "rent":
      return d.intro_rent;
    case "price":
      return d.intro_price;
    case "occupancy":
      return d.intro_occupancy;
    case "documents":
      return d.intro_documents;
    case "supply":
      return d.intro_supply;
    case "fees":
      return d.intro_fees;
    case "how":
      return d.intro_how;
    case "risk":
      return d.intro_risk;
    case "score":
      return d.intro_score;
    case "offering":
      return d.intro_offering;
    case "portfolio":
      return d.intro_portfolio;
    case "advice":
      return d.refuse_advice;
    case "prediction":
      return d.refuse_prediction;
    case "personal":
      return d.refuse_personal;
    case "unknown":
      return d.refuse_unknown;
  }
}

/** One line per fact: "label: value [n]". */
export function factLine(f: CitedFact): string {
  return f.value === "" ? `${f.text} [${String(f.n)}]` : `${f.text}: ${f.value} [${String(f.n)}]`;
}

export function groundedAnswer(q: Question, intent: Intent, r: Retrieved): Answer {
  const d = analystDict(q.lang);
  const facts = intent === "unknown" ? [] : citedFacts(r.facts, q.lang);
  const text: string[] = [intro(intent, d)];
  const starts = new Map(r.groups.map((g) => [g.start, g.heading]));
  const showHeadings = r.groups.filter((g) => g.heading !== "").length > 1;
  facts.forEach((f, i) => {
    const heading = starts.get(i);
    if (showHeadings && heading) text.push(heading);
    text.push(factLine(f));
  });
  text.push(...(intent === "unknown" ? [] : r.notes));
  const refused = intent === "advice" || intent === "prediction" || intent === "personal" || intent === "unknown" ? intent : undefined;
  return {
    intent,
    ...(refused ? { refused } : {}),
    text,
    facts,
    sources: distinctSources(facts),
    dataAsOf: r.dataAsOf,
    provider: "grounded",
    disclaimer: d.disclaimer,
    lang: q.lang,
    ...(intent === "unknown" ? { suggestions: analystSuggestions(q.lang, q.scope) } : {}),
  };
}

/** The answer when the rate limit refuses a question (no records read). */
export function rateLimitedAnswer(q: Pick<Question, "lang">, at: string): Answer {
  const d = analystDict(q.lang);
  return { intent: "unknown", refused: "rate", text: [d.rate_text], facts: [], sources: [], dataAsOf: { at, block: null }, provider: "grounded", disclaimer: d.disclaimer, lang: q.lang };
}

/** Portfolio questions without a signed-in investor. */
export function signInAnswer(q: Pick<Question, "lang">, at: string): Answer {
  const d = analystDict(q.lang);
  return { intent: "portfolio", text: [d.signinNeeded], facts: [], sources: [], dataAsOf: { at, block: null }, provider: "grounded", disclaimer: d.disclaimer, lang: q.lang };
}
