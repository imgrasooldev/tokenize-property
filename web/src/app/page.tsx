import { BuildingArt } from "@/components/BuildingArt";
import { PropertyCard } from "@/components/PropertyCard";
import { PROPERTIES } from "@/lib/properties";
import { liveToken } from "@/lib/server/chain";
import { getDict } from "@/lib/server/lang";

export const dynamic = "force-dynamic";

export default async function Home() {
  const { lang, t } = await getDict();
  const live = await Promise.all(PROPERTIES.map((p) => (p.status === "live" ? liveToken(p.symbol) : Promise.resolve(null))));
  const featured = PROPERTIES[0];

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
    </main>
  );
}
