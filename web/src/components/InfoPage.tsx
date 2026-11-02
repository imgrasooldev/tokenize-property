import Link from "next/link";
import { PublicPage } from "@/components/Shell";
import { INFO_PATHS, infoChrome, infoPage, type InfoKey } from "@/lib/i18n-info";
import { getDict } from "@/lib/server/lang";

/**
 * One public information page (terms, privacy, risks, fees, FAQ, about, reports, contact) in the
 * visitor's language, with a draft banner where the legal text is not yet approved and links to the
 * other pages.
 */
export async function InfoView({ page }: { page: InfoKey }) {
  const { lang } = await getDict();
  const p = infoPage(lang, page);
  const c = infoChrome(lang);
  return (
    <PublicPage active="none">
      <main id="main" className="wrap page info-page">
        <div className="kicker">
          {"// "}
          {p.kicker}
        </div>
        <h1 className="page-title">{p.title}</h1>
        <p className="lead-sm meta">{p.intro}</p>
        {p.draft ? (
          <p className="alert" role="note" data-testid="info-draft">
            {c.draft}
          </p>
        ) : null}
        <div className="info-grid">
          <article className="info-body">
            {p.sections.map((s) => (
              <section key={s.h} className="panel info-section">
                <h2>{s.h}</h2>
                {(s.p ?? []).map((t) => (
                  <p key={t}>{t}</p>
                ))}
                {s.list ? (
                  <ul>
                    {s.list.map((t) => (
                      <li key={t}>{t}</li>
                    ))}
                  </ul>
                ) : null}
              </section>
            ))}
            <p className="fine">{c.updated}</p>
          </article>
          <nav className="panel info-nav" aria-label={c.footHelp}>
            <ul>
              {(Object.keys(INFO_PATHS) as InfoKey[]).map((k) => (
                <li key={k}>
                  {k === page ? (
                    <b aria-current="page">{new Map(Object.entries(c.names)).get(k)}</b>
                  ) : (
                    <Link href={new Map(Object.entries(INFO_PATHS)).get(k) ?? "/"}>{new Map(Object.entries(c.names)).get(k)}</Link>
                  )}
                </li>
              ))}
            </ul>
          </nav>
        </div>
      </main>
    </PublicPage>
  );
}
