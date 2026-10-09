import Link from "next/link";
import { notFound } from "next/navigation";
import { BuildingArt } from "@/components/BuildingArt";
import { NavChart, RentChart } from "@/components/HistoryCharts";
import { formatNumber, formatPkr, loc } from "@/lib/i18n";
import { findProperty, sampleHistory } from "@/lib/properties";
import { liveToken } from "@/lib/server/chain";
import { getDict } from "@/lib/server/lang";

export const dynamic = "force-dynamic";

export default async function PropertyPage({ params }: { params: Promise<{ symbol: string }> }) {
  const { symbol } = await params;
  // Only catalogue symbols are valid; anything else is a 404 (no user input reaches the chain layer).
  const p = findProperty(symbol);
  if (!p) notFound();
  const { lang, t } = await getDict();
  const live = p.status === "live" ? await liveToken(p.symbol) : null;
  const history = sampleHistory(p);
  const minTokens = 10;

  return (
    <main className="container">
      <p style={{ marginBlock: "18px 0" }}>
        <Link href="/">{lang === "ur" ? "→" : "←"} {t.back}</Link>
      </p>
      <div className="detail">
        <div style={{ display: "grid", gap: 20 }}>
          <div className="card">
            <BuildingArt property={p} height={260} />
            <div className="body">
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {live ? <span className="chip green">● {t.liveOnChain}</span> : <span className="chip gray">{t.comingSoon}</span>}
                <span className="chip amber">{t.sample}</span>
              </div>
              <h1 style={{ margin: 0, fontSize: 26 }}>{loc(p.name, lang)}</h1>
              <div className="meta">
                {loc(p.city, lang)} · {p.type === "office" ? t.office : t.retail}
              </div>
            </div>
          </div>
          <section className="panel">
            <h2>{t.navChart}</h2>
            <p className="note">{t.sampleHistory}</p>
            <NavChart data={history} />
          </section>
          <section className="panel">
            <h2>{t.rentChart}</h2>
            <p className="note">{t.sampleHistory}</p>
            <RentChart data={history} />
          </section>
        </div>

        <aside style={{ display: "grid", gap: 20, alignContent: "start" }}>
          <section className="panel">
            <div className="stats" style={{ marginBlockEnd: 14 }}>
              <div className="stat">
                <div className="label">{t.pricePerToken}</div>
                <div className="value">{formatPkr(p.navPkr, lang)}</div>
              </div>
              <div className="stat">
                <div className="label">{t.yield}</div>
                <div className="value">{formatNumber(p.yieldPct, lang)}%</div>
              </div>
              <div className="stat">
                <div className="label">{t.occupancy}</div>
                <div className="value">{formatNumber(p.occupancyPct, lang)}%</div>
              </div>
            </div>
            <dl className="kv">
              <dt>{t.minInvestment}</dt>
              <dd>{formatPkr(p.navPkr * minTokens, lang)}</dd>
              <dt>{t.area}</dt>
              <dd>{formatNumber(p.areaSqft, lang)} sq ft</dd>
              <dt>{t.tenant}</dt>
              <dd>{loc(p.tenant, lang)}</dd>
            </dl>
            <div style={{ marginBlockStart: 16, display: "grid", gap: 8 }}>
              <span className="btn secondary" aria-disabled="true">
                {t.invest}
              </span>
              <span className="meta" style={{ fontSize: 12.5 }}>{t.investSoon}</span>
            </div>
          </section>

          <section className="panel">
            <h2>
              {t.liveOnChain} <span className="chip green">●</span>
            </h2>
            {live ? (
              <dl className="kv">
                <dt>{t.tokensIssued}</dt>
                <dd>{formatNumber(live.supply, lang)}</dd>
                <dt>{t.register}</dt>
                <dd>{formatNumber(live.cap, lang)}</dd>
                <dt>{t.trading}</dt>
                <dd>{live.paused ? <span className="chip red">{t.tradingPaused}</span> : <span className="chip green">{t.tradingLive}</span>}</dd>
                <dt>{t.tokenContract}</dt>
                <dd className="mono">{live.address}</dd>
              </dl>
            ) : (
              <p className="note">{p.status === "live" ? t.chainUnavailable : t.comingSoon}</p>
            )}
          </section>
        </aside>
      </div>
    </main>
  );
}
