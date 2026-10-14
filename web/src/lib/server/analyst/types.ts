import type { Lang } from "../../i18n";

/**
 * Property analyst (ADR 0015): answers questions ONLY from records the website already reads, each
 * figure cited to its source. Not investment advice. Every type here is plain data (no bigint), so
 * an Answer can be returned from a server action as is.
 */

export type Scope = "site" | "property" | "portfolio";

export type Intent =
  | "yield"
  | "rent"
  | "price"
  | "occupancy"
  | "documents"
  | "supply"
  | "fees"
  | "how"
  | "risk"
  | "score"
  | "offering"
  | "portfolio"
  // guardrails (never sent to an external model)
  | "advice"
  | "prediction"
  | "personal"
  | "unknown";

export type Refusal = "advice" | "prediction" | "personal" | "unknown" | "rate";

export interface Question {
  text: string;
  lang: Lang;
  scope: Scope;
  /** Token symbol or offering id of the property the question is about (property scope). */
  propertyKey?: string;
}

export type SourceKind = "chain" | "document" | "offering" | "property" | "recon" | "ledger" | "market" | "site";

export interface Source {
  kind: SourceKind;
  /** Block number, document SHA-256, table/record id or transaction hash. Never personal data. */
  ref: string;
  /** ISO time the figure is from, when known. */
  asOf?: string;
}

export interface Fact {
  /** Stable id, e.g. "GPF3.supply". */
  id: string;
  /** Label in English. */
  text: string;
  /** Label in Urdu. */
  textUr?: string;
  /** The figure as displayed (already formatted; may be empty for a statement). */
  value: string;
  source: Source;
}

/** A fact as shown with an answer: its citation number and its label in the question's language. */
export interface CitedFact {
  n: number;
  id: string;
  text: string;
  value: string;
  source: Source;
}

export interface Answer {
  intent: Intent;
  refused?: Refusal;
  /** Paragraphs in the question's language; citations as [1], [2]… */
  text: string[];
  /** Facts cited in the text (each [n] in the text is one of these). */
  facts: CitedFact[];
  /** Distinct sources of the cited facts. */
  sources: Source[];
  dataAsOf: { at: string; block: string | null };
  provider: "grounded" | "claude";
  disclaimer: string;
  lang: Lang;
  /** Follow-up questions (shown as chips for unknown questions). */
  suggestions?: string[];
}

/** Facts gathered for one question, with the time and block they are from. */
export interface Retrieved {
  facts: Fact[];
  /** Plain notes without figures (e.g. "no fee schedule published"), in the question's language. */
  notes: string[];
  /** Section headings: index in `facts` where a property's facts start, with its heading. */
  groups: { start: number; heading: string }[];
  dataAsOf: { at: string; block: string | null };
  /** Names and keys of the properties involved (they may contain digits; not figures). */
  names: string[];
}
