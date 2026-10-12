import Link from "next/link";
import { PublicPage, Sample, Spark } from "@/components/Shell";
import { formatNumber, formatPkr, loc } from "@/lib/i18n";
import { PROPERTIES } from "@/lib/properties";
import { sampleScore } from "@/lib/sample-ai";
import { liveToken } from "@/lib/server/chain";
import { getDict } from "@/lib/server/lang";

export const dynamic = "force-dynamic";

/** All properties: the same catalogue and live chain data as the home page, as one table. */
export default async function PropertiesPage({ searchParams }: { searchParams: Promise<{ f?: string }> }) {
  const { lang, t } = await getDict();
  const { f } = await searchParams;
  const filter = f === "live" || f === "soon" ? f : "all";
  const rows = await Promise.all(
    PROPERTIES.map(async (p) => ({ p, live: p.status === "live" ? await liveToken(p.symbol) : null })),
  );
  const shown = rows.filter(({ p }) => filter === "all" || (filter === "live" ? p.status === "live" : p.status !== "live"));
  const tabs = [
    { key: "all", href: "/properties", label: t.tabAll },
    { key: "live", href: "/properties?f=live", label: t.tabLive },
    { key: "soon", href: "/properties?f=soon", label: t.tabSoon },
  ];

  return (
    <PublicPage active="properties">
      <main id="main" className="wrap page">
        <div className="kicker">{"// "}{t.kPropsList}</div>
        <h1 className="page-title">
          {t.propsListTitle1} <span className="grad">{t.propsListTitle2}</span>
        </h1>

        <div className="map glass">
          <svg viewBox="0 0 1200 300" width="100%" height="300" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
            <path
              d="M520 30 L640 20 L720 60 L760 120 L700 170 L640 210 L560 270 L470 280 L430 230 L470 170 L450 110 Z"
              fill="rgba(34,227,240,.05)"
              stroke="rgba(34,227,240,.4)"
              strokeDasharray="4 5"
            />
            <g stroke="#8B5CF6" strokeWidth="1.5" strokeDasharray="4 6" fill="none" opacity=".8" className="map-links">
              <path d="M640 95 L660 70" />
              <path d="M640 95 L500 250" />
            </g>
            <circle cx="640" cy="95" r="9" fill="#22E3F0" className="map-pulse" />
            <circle cx="660" cy="70" r="7" fill="#F472B6" />
            <circle cx="500" cy="250" r="7" fill="#2EF2B5" />
          </svg>
          <ul className="map-labels">
            {PROPERTIES.map((p) => (
              <li key={p.symbol} className={`ml-${p.symbol}`}>
                {loc(p.city, lang)} · {p.symbol} {p.status === "live" ? `· ${t.liveShort}` : `· ${t.comingSoon}`}
              </li>
            ))}
          </ul>
          <span className="chip map-tag">
            {t.mapTag} <Sample t={t} />
          </span>
        </div>

        <div className="filters">
          <nav className="tabs" aria-label={t.filterLabel}>
            {tabs.map((x) => (
              <Link key={x.key} href={x.href} className={x.key === filter ? "on" : undefined} aria-current={x.key === filter ? "page" : undefined}>
                {x.label}
              </Link>
            ))}
          </nav>
          <span className="chip" aria-disabled="true">
            {t.city}: {t.tabAll}
          </span>
          <span className="chip" aria-disabled="true">
            {t.typeLabel}: {t.office}, {t.retail}
          </span>
          <Sample t={t} soon />
          <span className="sp" />
          <span className="chip ai">
            <Spark /> {t.aiSort} <Sample t={t} soon />
          </span>
        </div>

        <div className="glass table-wrap">
          <table className="table t">
            <thead>
              <tr>
                <th>{t.property}</th>
                <th>{t.city}</th>
                <th className="n">{t.pricePerToken}</th>
                <th className="n">{t.yield}</th>
                <th className="n">{t.occupancy}</th>
                <th>{t.registerIssued}</th>
                <th>
                  {t.aiScore} <Sample t={t} />
                </th>
                <th>{t.status}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {shown.map(({ p, live }) => {
                const pct = live && live.cap > 0n ? Number((live.supply * 10_000n) / live.cap) / 100 : 0;
                const ai = sampleScore(p.symbol);
                return (
                  <tr key={p.symbol}>
                    <td>
                      <b>{loc(p.name, lang)}</b>
                      <div className="di mono small">
                        {p.symbol} · {p.type === "office" ? t.office : t.retail} · {loc(p.tenant, lang)}
                      </div>
                    </td>
                    <td>{loc(p.city, lang)}</td>
                    <td className="n">{formatPkr(p.navPkr, lang)}</td>
                    <td className="n up">{formatNumber(p.yieldPct, lang)}%</td>
                    <td className="n">{formatNumber(p.occupancyPct, lang)}%</td>
                    <td style={{ minInlineSize: 120 }}>
                      <div className="bar">
                        <i style={{ inlineSize: `${String(Math.min(pct, 100))}%` }} />
                      </div>
                      <span className="mono di small">{live ? `${formatNumber(pct, lang)}%` : "—"}</span>
                    </td>
                    <td>{ai && <span className="chip ai">{ai.score}</span>}</td>
                    <td>
                      {live ? (
                        <span className="chip ok">
                          <span className="dot" aria-hidden="true" />
                          {t.liveShort}
                        </span>
                      ) : (
                        <span className="chip warn">{p.status === "live" ? t.chainUnavailable : t.comingSoon}</span>
                      )}
                    </td>
                    <td>
                      <Link className={`btn small ${live ? "" : "secondary"}`} href={`/properties/${p.symbol}`}>
                        {t.viewShort}
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="fine">{t.propsListNote}</p>
      </main>
    </PublicPage>
  );
}
