import { BuildingArt } from "@/components/BuildingArt";
import Link from "next/link";
import { PropertyCard } from "@/components/PropertyCard";
import { formatNumber, formatPrice } from "@/lib/i18n";
import { PROPERTIES } from "@/lib/properties";
import { liveToken } from "@/lib/server/chain";
import { getDict } from "@/lib/server/lang";
import { marketSnapshot } from "@/lib/server/market";

export const dynamic = "force-dynamic";

export default async function Home() {
  const { lang, t } = await getDict();
  const live = await Promise.all(PROPERTIES.map((p) => (p.status === "live" ? liveToken(p.symbol) : Promise.resolve(null))));
  const featured = PROPERTIES[0];
  const liveP = PROPERTIES.find((p) => p.status === "live");
  const market = liveP ? await marketSnapshot(liveP.symbol).catch(() => null) : null;
  const last = market?.last === null || market?.last === undefined ? null : Number(market.last) / 100;

  return (
    <main className="container">
      <section className="hero">
        <div>
          <h1>{t.heroTitle}</h1>
          <p>{t.heroBody}</p>
          <span className="chip teal">{t.heroSafety}</span>
        </div>
        {featured && (
          <div className="card">
            <BuildingArt property={featured} height={220} />
          </div>
        )}
      </section>

      <h2 className="section-title">{t.howItWorks}</h2>
      <div className="steps">
        {[t.step1, t.step2, t.step3, t.step4].map((s, i) => (
          <div className="step" key={s}>
            <b>{i + 1}</b>
            {s}
          </div>
        ))}
      </div>

      <h2 className="section-title">{t.navProperties}</h2>
      <div className="grid">
        {PROPERTIES.map((p, i) => (
          <PropertyCard key={p.symbol} p={p} live={live.at(i) ?? null} lang={lang} t={t} />
        ))}
      </div>

      {liveP && (
        <section className="panel teaser" style={{ marginBlock: 28 }}>
          <div>
            <h2>
              {t.marketTeaser} <span className="chip amber">{t.demo}</span>
            </h2>
            <p className="note">{t.marketTeaserBody}</p>
          </div>
          <div className="stats">
            <div className="stat">
              <div className="label">{liveP.symbol} · {t.lastPrice}</div>
              <div className="value">{last === null ? "—" : formatPrice(last, lang)}</div>
            </div>
            <div className="stat">
              <div className="label">{t.vsNav}</div>
              <div className="value" dir="ltr">
                {last === null ? "—" : `${last >= liveP.navPkr ? "+" : ""}${(((last - liveP.navPkr) / liveP.navPkr) * 100).toFixed(2)}%`}
              </div>
            </div>
            <div className="stat">
              <div className="label">{t.volume24h}</div>
              <div className="value">{formatNumber(market?.volume24h ?? 0n, lang)}</div>
            </div>
          </div>
          <Link href="/market" className="btn">
            {t.openMarket}
          </Link>
        </section>
      )}
    </main>
  );
}
