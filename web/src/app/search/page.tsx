import type { Metadata } from "next";
import Link from "next/link";
import { AnswerView } from "@/components/analyst/AnswerView";
import { PublicPage } from "@/components/Shell";
import { aLabel, analystDict, fillA } from "@/lib/i18n-analyst";
import { answer, detectIntent, type Answer } from "@/lib/server/analyst";
import { catalog } from "@/lib/server/catalog";
import { investorById } from "@/lib/server/db";
import { getLang } from "@/lib/server/lang";
import { logError } from "@/lib/server/log";
import { searchCatalog, type SearchOutcome } from "@/lib/server/search";
import { currentInvestorId } from "@/lib/server/session";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Search · Property Token" };

/**
 * Site search and question page (ADR 0015). Server-rendered from `?q=`, so it works without
 * JavaScript. A question also gets the grounded analyst answer (grounded only on this page: a GET
 * or a link prefetch never calls an external model).
 */
export default async function SearchPage({ searchParams }: { searchParams: Promise<{ q?: string | string[]; scope?: string | string[] }> }) {
  const sp = await searchParams;
  const q = (Array.isArray(sp.q) ? sp.q[0] : sp.q)?.slice(0, 300) ?? "";
  const wantsPortfolio = (Array.isArray(sp.scope) ? sp.scope[0] : sp.scope) === "portfolio";
  const lang = await getLang();
  const d = analystDict(lang);
  const trimmed = q.trim();

  const cat = await catalog().catch(() => null);
  const outcome: SearchOutcome = searchCatalog(trimmed, lang, cat?.entries ?? []);

  let analyst: Answer | null = null;
  if (trimmed.length >= 2) {
    const scope = wantsPortfolio ? "portfolio" : "site";
    const intent = detectIntent(trimmed, scope);
    if (intent !== "unknown") {
      try {
        const id = await currentInvestorId();
        const investor = id ? await investorById(id).catch(() => null) : null;
        analyst = await answer({ text: trimmed, lang, scope: scope === "portfolio" && !investor ? "site" : scope }, { investor, groundedOnly: true });
      } catch (e) {
        logError("search", e instanceof Error ? e.name : "Error");
      }
    }
  }

  const count = outcome.ok ? outcome.results.length : 0;
  const summary = !outcome.ok
    ? outcome.reason === "tooLong"
      ? d.tooLong
      : d.emptyQuery
    : count === 0
      ? fillA(d.noResults, { q: trimmed })
      : fillA(count === 1 ? d.resultsOne : d.resultsMany, { n: count, q: trimmed });

  return (
    <PublicPage active="none">
      <main id="main" className="wrap page srch-page">
        <div className="kicker">
          {"// "}
          {d.searchKicker}
        </div>
        <h1 className="page-title">{d.searchTitle}</h1>
        <form role="search" action="/search" method="get" className="srch-form" aria-label={d.searchTitle}>
          <label htmlFor="search-q" className="srch-label">
            {d.searchLabel}
          </label>
          <div className="srch-row">
            <input id="search-q" name="q" type="search" defaultValue={q} maxLength={300} placeholder={d.searchPlaceholder} autoComplete="off" enterKeyHint="search" data-search="page" />
            {wantsPortfolio && <input type="hidden" name="scope" value="portfolio" />}
            <button type="submit" className="btn small">
              {d.searchBtn}
            </button>
          </div>
        </form>

        {analyst && (
          <section className="panel srch-answer" aria-labelledby="srch-answer-title">
            <h2 id="srch-answer-title" className="srch-h2">
              {d.analystOnSearch}
            </h2>
            <AnswerView answer={analyst} idPrefix="srch" />
          </section>
        )}

        <section className="srch-results" aria-labelledby="srch-results-title">
          <h2 id="srch-results-title" className="srch-h2">
            {d.resultsTitle}
          </h2>
          <p className="meta" role="status">
            {summary}
          </p>
          {outcome.ok && count > 0 && (
            <ol className="srch-list">
              {outcome.results.map((r) => (
                <li key={`${r.kind}:${r.key}`}>
                  <Link href={r.href} className="srch-item">
                    <span className="chip">{r.kind === "property" ? d.type_property : d.type_page}</span>
                    <span className="srch-main">
                      <b>{r.title}</b>
                      <span className="srch-sub">{r.subtitle}</span>
                    </span>
                    <span className="srch-why">{fillA(d.matchedOn, { f: aLabel(d, `field_${r.matched}`, r.matched) })}</span>
                  </Link>
                </li>
              ))}
            </ol>
          )}
        </section>
      </main>
    </PublicPage>
  );
}
