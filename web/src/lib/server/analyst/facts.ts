import type { Lang } from "../../i18n";
import { aLabel, analystDict, fillA, type AnalystDict } from "../../i18n-analyst";
import { label as offeringLabel, offeringDict } from "../../i18n-offering";
import type { Catalog, CatalogEntry } from "../catalog";
import { formatBp, formatPaisa, formatPkt, formatPktDay, groupDigits } from "./format";
import type { Fact, Intent, Retrieved, Source } from "./types";

/**
 * Fact builders (pure, ADR 0015). Every fact is a figure that is already in a record the website
 * reads, with that record as its source. Nothing is estimated: a missing record gives no fact (and,
 * where it matters, a plain note saying it is not published).
 */

const EN = analystDict("en");
const UR = analystDict("ur");

type Vars = Record<string, string | number>;

function fact(id: string, key: keyof AnalystDict, vars: Vars, value: string, source: Source, urVars?: Vars): Fact {
  return {
    id,
    text: fillA(aLabel(EN, key), vars),
    textUr: fillA(aLabel(UR, key), urVars ?? vars),
    value,
    source,
  };
}

const MAX_DISTRIBUTIONS = 6;
const MAX_ENTRIES = 4;
export const MAX_FACTS = 24;

type CatalogLike = Pick<Catalog, "at" | "block" | "recon" | "entries">;

function chainSource(block: bigint | string | null, at: string): Source {
  return { kind: "chain", ref: block === null ? "read model" : `block ${block.toString()}`, asOf: at };
}

function offeringSource(e: CatalogEntry, at: string): Source | null {
  return e.offering ? { kind: "offering", ref: `offering ${e.offering.offeringId}`, asOf: at } : null;
}

function propertySource(e: CatalogEntry, at: string): Source {
  if (e.offering) return { kind: "property", ref: `property.web_catalog ${e.offering.offeringId}`, asOf: at };
  return { kind: "property", ref: `listing ${e.key}`, asOf: at };
}

const yn = (b: boolean, d: AnalystDict): string => (b ? d.yes : d.no);

// ------------------------------------------------------------------ per-entry facts
function issuePrice(e: CatalogEntry, at: string, lang: Lang): Fact | null {
  if (e.issuePricePaisa === null) return null;
  const src = e.offering ? (offeringSource(e, at) ?? propertySource(e, at)) : propertySource(e, at);
  return fact(`${e.key}.issuePrice`, "f_issuePrice", {}, formatPaisa(e.issuePricePaisa, lang), src);
}

function lastTrade(e: CatalogEntry, at: string, lang: Lang): Fact | null {
  if (e.lastPricePaisa === null || e.symbol === null) return null;
  return fact(`${e.key}.lastTrade`, "f_lastTrade", {}, formatPaisa(e.lastPricePaisa, lang), { kind: "market", ref: `webdemo.trades ${e.symbol}`, asOf: at });
}

function supply(e: CatalogEntry, at: string): Fact[] {
  if (!e.token) return [];
  const src = chainSource(e.token.asOfBlock, at);
  return [fact(`${e.key}.supply`, "f_supply", {}, groupDigits(e.token.supply), src), fact(`${e.key}.cap`, "f_cap", {}, groupDigits(e.token.cap), src)];
}

function paused(e: CatalogEntry, at: string, d: AnalystDict): Fact | null {
  if (!e.token) return null;
  return fact(`${e.key}.paused`, "f_paused", {}, yn(e.token.paused, d), chainSource(e.token.asOfBlock, at));
}

function holders(e: CatalogEntry, cat: CatalogLike): Fact[] {
  const out: Fact[] = [];
  const src = chainSource(e.token?.asOfBlock ?? cat.block, cat.at);
  if (e.holders !== null) out.push(fact(`${e.key}.holders`, "f_holders", {}, groupDigits(e.holders), src));
  if (e.topHolderBp !== null) out.push(fact(`${e.key}.topHolder`, "f_topHolder", {}, formatBp(e.topHolderBp), src));
  return out;
}

function yieldFacts(e: CatalogEntry, at: string, lang: Lang): Fact[] {
  if (!e.yield || !e.token) return [];
  const src = chainSource(e.token.asOfBlock, at);
  const out = [
    fact(`${e.key}.rent12`, "f_rent12", {}, formatPaisa(e.yield.rentPaisa12m, lang), src),
    fact(`${e.key}.rentMonths`, "f_rentMonths", {}, groupDigits(e.yield.months), src),
  ];
  if (e.yield.yieldBp !== null) out.push(fact(`${e.key}.yield`, "f_yield", {}, formatBp(e.yield.yieldBp), src));
  return out;
}

function distributions(e: CatalogEntry, at: string, lang: Lang): Fact[] {
  if (e.distributions === null || !e.token) return [];
  if (e.distributions.length === 0) return [fact(`${e.key}.dist.none`, "f_noDist", {}, analystDict(lang).none, chainSource(e.token.asOfBlock, at))];
  return e.distributions.slice(0, MAX_DISTRIBUTIONS).map((x) => {
    const day = formatPktDay(x.publishedAt);
    return fact(
      `${e.key}.dist.${x.id.toString()}`,
      "f_dist",
      { id: x.id.toString(), status: aLabel(EN, `dist_${x.status}`, x.status), date: day },
      formatPaisa(x.totalPaisa, lang),
      { kind: "chain", ref: `block ${x.recordBlock.toString()}`, asOf: x.publishedAt.toISOString() },
      { id: x.id.toString(), status: aLabel(UR, `dist_${x.status}`, x.status), date: day },
    );
  });
}

function occupancy(e: CatalogEntry, at: string, lang: Lang, d: AnalystDict): Fact[] {
  const f = e.facts;
  if (!f) return [];
  const src = propertySource(e, at);
  const out: Fact[] = [];
  if (f.occupancy !== null) out.push(fact(`${e.key}.occupancy`, "f_occupancy", {}, aLabel(d, `occ_${f.occupancy}`, f.occupancy), src));
  if (f.leaseCount !== null) out.push(fact(`${e.key}.leases`, "f_leases", {}, groupDigits(f.leaseCount), src));
  if (f.monthlyRentPaisa !== null) out.push(fact(`${e.key}.declaredRent`, "f_declaredRent", {}, formatPaisa(f.monthlyRentPaisa, lang), src));
  if (f.trusteeAcceptedAt !== null) out.push(fact(`${e.key}.trustee`, "f_trustee", {}, formatPkt(f.trusteeAcceptedAt), src));
  return out;
}

function valuation(e: CatalogEntry, at: string, lang: Lang): Fact | null {
  const f = e.facts;
  if (!f || f.valuationLowPaisa === null || f.valuationHighPaisa === null) return null;
  const range = `${formatPaisa(f.valuationLowPaisa, lang)} – ${formatPaisa(f.valuationHighPaisa, lang)}${f.valuedOn ? ` (${f.valuedOn})` : ""}`;
  return fact(`${e.key}.valuation`, "f_valuation", {}, range, propertySource(e, at));
}

function documents(e: CatalogEntry, at: string): Fact[] {
  const out: Fact[] = [];
  for (const doc of (e.chainDocuments ?? []).filter((x) => x.supersededBy === null)) {
    const type = `doc_${String(doc.docType)}`;
    out.push(
      fact(`${e.key}.doc.chain.${doc.id.toString()}`, "f_doc", { type: aLabel(EN, type, type) }, doc.sha256, { kind: "document", ref: doc.sha256, asOf: doc.addedAt?.toISOString() ?? at }, { type: aLabel(UR, type, type) }),
    );
  }
  for (const doc of e.documents) {
    const en = doc.docType.replace(/_/g, " ");
    out.push(fact(`${e.key}.doc.pub.${doc.sha256}`, "f_doc", { type: en }, doc.sha256, { kind: "document", ref: doc.sha256, asOf: doc.uploadedAt }, { type: en }));
  }
  const o = e.offering;
  if (o) {
    const extra: [string, keyof AnalystDict][] = [];
    if (o.docEnSha) extra.push([o.docEnSha, "doc_offering_en"]);
    if (o.docUrSha) extra.push([o.docUrSha, "doc_offering_ur"]);
    if (o.riskSha) extra.push([o.riskSha, "doc_risk"]);
    for (const [sha, key] of extra) {
      out.push(fact(`${e.key}.doc.offering.${key}`, "f_doc", { type: aLabel(EN, key) }, sha, { kind: "document", ref: sha, asOf: at }, { type: aLabel(UR, key) }));
    }
  }
  return out;
}

function docClasses(e: CatalogEntry, cat: CatalogLike, d: AnalystDict): Fact | null {
  const f = e.score.factors.find((x) => x.key === "documents");
  if (!f || f.points === null) return null;
  const n = Math.floor(f.points / 25);
  const src: Source = e.token ? chainSource(e.token.asOfBlock, cat.at) : e.offering ? { kind: "document", ref: `property.web_documents ${e.offering.offeringId}`, asOf: cat.at } : chainSource(cat.block, cat.at);
  return fact(`${e.key}.docClasses`, "f_docClasses", {}, fillA(d.of4, { n }), src);
}

function offeringTerms(e: CatalogEntry, at: string, lang: Lang, d: AnalystDict): Fact[] {
  const o = e.offering;
  const src = offeringSource(e, at);
  if (!o || !src) return [];
  const od = offeringDict(lang);
  const out = [
    fact(`${e.key}.offState`, "f_offState", {}, offeringLabel(od, "st_", o.state), src),
    fact(`${e.key}.offPrice`, "f_offPrice", {}, formatPaisa(o.pricePaisa, lang), src),
    fact(`${e.key}.offTarget`, "f_offTarget", {}, groupDigits(o.targetUnits), src),
    fact(`${e.key}.offHardCap`, "f_offHardCap", {}, groupDigits(o.hardCapUnits), src),
    fact(`${e.key}.offMinMax`, "f_offMinMax", {}, `${groupDigits(o.minUnits)} – ${groupDigits(o.maxUnits)}`, src),
    fact(`${e.key}.offPaid`, "f_offPaid", {}, groupDigits(o.paidUnits), src),
    fact(`${e.key}.offAvailable`, "f_offAvailable", {}, groupDigits(o.availableUnits), src),
    fact(`${e.key}.offAllOrNothing`, "f_offAllOrNothing", {}, yn(o.allOrNothing, d), src),
  ];
  if (o.opensAt) out.push(fact(`${e.key}.offOpens`, "f_offOpens", {}, formatPkt(o.opensAt), src));
  if (o.closesAt) out.push(fact(`${e.key}.offCloses`, "f_offCloses", {}, formatPkt(o.closesAt), src));
  return out;
}

function offeringState(e: CatalogEntry, at: string, lang: Lang): Fact | null {
  const o = e.offering;
  const src = offeringSource(e, at);
  if (!o || !src) return null;
  return fact(`${e.key}.offState`, "f_offState", {}, offeringLabel(offeringDict(lang), "st_", o.state), src);
}

function fees(e: CatalogEntry, at: string, lang: Lang): Fact[] {
  const o = e.offering;
  const src = offeringSource(e, at);
  if (!o || !src) return [];
  return o.useOfProceeds
    .filter((l) => l.line === "platform_fee")
    .map((l, i) => fact(`${e.key}.fee.${String(i)}`, "f_fee", {}, formatPaisa(l.paisa, lang), src));
}

const SCORE_SOURCE: Source = { kind: "site", ref: "score rules (ADR 0015, web/src/lib/score.ts)" };

function score(e: CatalogEntry, d: AnalystDict): Fact[] {
  const s = e.score;
  const out: Fact[] = [];
  if (s.score === null) out.push(fact(`${e.key}.score`, "f_scoreNone", {}, d.notScored, SCORE_SOURCE));
  else out.push(fact(`${e.key}.score`, "f_score", {}, groupDigits(s.score), SCORE_SOURCE));
  out.push(fact(`${e.key}.scoreCoverage`, "f_scoreCoverage", {}, `${String(s.coverage)}%`, SCORE_SOURCE));
  for (const f of s.factors) {
    if (f.points === null) continue;
    const fk = `factor_${f.key}`;
    out.push(
      fact(`${e.key}.factor.${f.key}`, "f_factor", { f: aLabel(EN, fk, f.key), w: f.weight }, fillA(d.pointsOf, { p: f.points }), SCORE_SOURCE, { f: aLabel(UR, fk, f.key), w: f.weight }),
    );
  }
  return out;
}

function reconFacts(cat: CatalogLike, d: AnalystDict): Fact[] {
  const r = cat.recon;
  if (!r) return [];
  const src: Source = { kind: "recon", ref: r.pinnedBlock ? `recon run, pinned block ${r.pinnedBlock}` : "recon run", asOf: r.finishedAt };
  const out = [fact("site.recon", "f_recon", {}, `${r.status === "passed" ? d.passed : d.failed} (${formatPkt(r.finishedAt)})`, src)];
  if (r.blocking > 0) out.push(fact("site.reconBlocking", "f_reconBlocking", {}, groupDigits(r.blocking), src));
  return out;
}

const HOW: (keyof AnalystDict)[] = ["how_kyc", "how_offering", "how_trustee", "how_rent", "how_verify"];
const HOW_REF: Record<string, string> = { how_kyc: "/signup", how_offering: "/offerings", how_trustee: "/offerings", how_rent: "/verify", how_verify: "/verify" };

function howFacts(cat: CatalogLike): Fact[] {
  const out = HOW.map((k) => fact(`site.${k}`, k, {}, "", { kind: "site", ref: new Map(Object.entries(HOW_REF)).get(k) ?? "/" }));
  out.push(fact("site.properties", "f_properties", {}, groupDigits(cat.entries.length), { kind: "site", ref: "/properties", asOf: cat.at }));
  return out;
}

const nn = <T>(x: T | null): x is T => x !== null;

/** Facts about one property for an intent. */
export function entryFacts(e: CatalogEntry, intent: Intent, cat: CatalogLike, lang: Lang): Fact[] {
  const d = analystDict(lang);
  const at = cat.at;
  switch (intent) {
    case "yield":
      return [issuePrice(e, at, lang), ...yieldFacts(e, at, lang)].filter(nn);
    case "rent":
      return [...yieldFacts(e, at, lang).slice(0, 2), ...distributions(e, at, lang)];
    case "price":
      return [issuePrice(e, at, lang), lastTrade(e, at, lang), valuation(e, at, lang)].filter(nn);
    case "occupancy":
      return occupancy(e, at, lang, d);
    case "documents":
      return documents(e, at);
    case "supply":
      return [...supply(e, at), ...holders(e, cat), paused(e, at, d)].filter(nn);
    case "fees":
      return fees(e, at, lang);
    case "risk":
      return [...holders(e, cat).filter((f) => f.id.endsWith(".topHolder")), paused(e, at, d), docClasses(e, cat, d), offeringState(e, at, lang), ...yieldFacts(e, at, lang).filter((f) => f.id.endsWith(".rentMonths"))].filter(nn);
    case "score":
      return score(e, d);
    case "offering":
      return offeringTerms(e, at, lang, d);
    case "advice":
      return [issuePrice(e, at, lang), lastTrade(e, at, lang), ...yieldFacts(e, at, lang).filter((f) => f.id.endsWith(".yield")), ...score(e, d).slice(0, 1), docClasses(e, cat, d)].filter(nn);
    case "prediction":
      return [issuePrice(e, at, lang), lastTrade(e, at, lang), ...yieldFacts(e, at, lang).filter((f) => f.id.endsWith(".yield"))].filter(nn);
    case "personal":
      return [issuePrice(e, at, lang), ...offeringTerms(e, at, lang, d).filter((f) => f.id.endsWith(".offMinMax"))].filter(nn);
    case "how":
    case "portfolio":
    case "unknown":
      return [];
  }
}

/** Site-wide facts for an intent (not tied to one property). */
function siteFacts(intent: Intent, cat: CatalogLike, lang: Lang): Fact[] {
  const d = analystDict(lang);
  if (intent === "how" || intent === "personal") return howFacts(cat);
  if (intent === "risk" || intent === "advice") return reconFacts(cat, d);
  return [];
}

/** Notes (no figures) for an intent when records are missing. */
function notesFor(intent: Intent, facts: Fact[], d: AnalystDict): string[] {
  if (intent === "fees" && facts.length === 0) return [d.feesNone];
  if (intent === "yield" && facts.length > 0) return [d.yieldNote];
  if (intent === "score") return [d.scoreNote];
  if (intent === "risk" || intent === "advice") return [d.riskNote];
  if (facts.length === 0 && intent !== "unknown") return [d.noFacts];
  return [];
}

/** Builds the facts for a question about the given properties (at most MAX_ENTRIES). */
export function buildRetrieved(cat: CatalogLike, targets: CatalogEntry[], intent: Intent, lang: Lang): Retrieved {
  const d = analystDict(lang);
  const facts: Fact[] = [];
  const groups: Retrieved["groups"] = [];
  const names: string[] = [];
  for (const e of targets.slice(0, MAX_ENTRIES)) {
    const ef = entryFacts(e, intent, cat, lang);
    names.push(e.name.en, e.name.ur, e.key);
    if (ef.length === 0) continue;
    groups.push({ start: facts.length, heading: fillA(d.propertyHeading, { name: lang === "ur" ? e.name.ur : e.name.en, key: e.symbol ?? e.key }) });
    facts.push(...ef);
  }
  const sf = siteFacts(intent, cat, lang);
  if (sf.length > 0 && groups.length > 0) groups.push({ start: facts.length, heading: "" });
  facts.push(...sf);
  const capped = facts.slice(0, MAX_FACTS);
  return { facts: capped, notes: notesFor(intent, capped, d), groups: groups.filter((g) => g.start < capped.length), dataAsOf: { at: cat.at, block: cat.block }, names };
}

// ------------------------------------------------------------------ portfolio (signed-in investor only)
export interface PortfolioData {
  at: string;
  block: string | null;
  holdings: { symbol: string; tokens: bigint; asOfBlock: string; issuePricePaisa: bigint }[];
  rent: { receivedPaisa: bigint; count: number; latestBlock: string | null } | null;
  subs: { completed: number; completedPaisa: bigint; open: number } | null;
  offeringSubs: { active: number; amountPaisa: bigint } | null;
}

/** The signed-in investor's own aggregate figures. No name, CNIC, wallet or ids are included. */
export function portfolioFacts(p: PortfolioData, lang: Lang): Retrieved {
  const d = analystDict(lang);
  const facts: Fact[] = [];
  for (const h of p.holdings) {
    const src: Source = { kind: "chain", ref: `block ${h.asOfBlock}`, asOf: p.at };
    facts.push(fact(`my.${h.symbol}.tokens`, "f_my_tokens", { s: h.symbol }, groupDigits(h.tokens), src));
    if (h.tokens > 0n) facts.push(fact(`my.${h.symbol}.value`, "f_my_value", { s: h.symbol }, formatPaisa(h.tokens * h.issuePricePaisa, lang), src));
  }
  if (p.rent) {
    const src: Source = { kind: "chain", ref: p.rent.latestBlock ? `block ${p.rent.latestBlock} (rent statements)` : "rent statements", asOf: p.at };
    facts.push(fact("my.rent", "f_my_rent", {}, formatPaisa(p.rent.receivedPaisa, lang), src));
    facts.push(fact("my.rentCount", "f_my_rentCount", {}, groupDigits(p.rent.count), src));
  }
  if (p.subs && (p.subs.completed > 0 || p.subs.open > 0)) {
    const src: Source = { kind: "ledger", ref: "webdemo.subscriptions", asOf: p.at };
    facts.push(fact("my.invested", "f_my_invested", {}, formatPaisa(p.subs.completedPaisa, lang), src));
    facts.push(fact("my.open", "f_my_open", {}, groupDigits(p.subs.open), src));
  }
  if (p.offeringSubs && p.offeringSubs.active > 0) {
    facts.push(fact("my.offSubs", "f_my_offSubs", {}, `${groupDigits(p.offeringSubs.active)} (${formatPaisa(p.offeringSubs.amountPaisa, lang)})`, { kind: "offering", ref: "offering.web_my_subscriptions", asOf: p.at }));
  }
  const empty =
    p.holdings.every((h) => h.tokens === 0n) &&
    (p.rent === null || p.rent.receivedPaisa === 0n) &&
    (p.subs === null || (p.subs.completed === 0 && p.subs.open === 0)) &&
    (p.offeringSubs === null || p.offeringSubs.active === 0);
  return { facts, notes: empty ? [d.portfolioNone] : [], groups: [], dataAsOf: { at: p.at, block: p.block }, names: p.holdings.map((h) => h.symbol) };
}
