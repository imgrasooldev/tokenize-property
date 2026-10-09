import Link from "next/link";
import { formatNumber, formatPkr, loc, type Dict, type Lang } from "@/lib/i18n";
import type { Property } from "@/lib/properties";
import type { LiveToken } from "@/lib/server/chain";
import { BuildingArt } from "./BuildingArt";

export function PropertyCard({ p, live, lang, t }: { p: Property; live: LiveToken | null; lang: Lang; t: Dict }) {
  const soldPct = live && live.cap > 0n ? Number((live.supply * 10_000n) / live.cap) / 100 : 0;
  return (
    <article className="card">
      <BuildingArt property={p} />
      <div className="body">
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {p.status === "live" && live ? (
            <span className="chip green">● {t.liveOnChain}</span>
          ) : (
            <span className="chip gray">{t.comingSoon}</span>
          )}
          <span className="chip amber">{t.sample}</span>
          <span className="chip teal">{p.type === "office" ? t.office : t.retail}</span>
        </div>
        <div>
          <h3>{loc(p.name, lang)}</h3>
          <div className="meta">
            {loc(p.city, lang)} · {formatNumber(p.areaSqft, lang)} sq ft
          </div>
        </div>
        <div className="stats">
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
        {live && (
          <div>
            <div className="meta">
              {formatNumber(soldPct, lang)}% {t.sold} · {formatNumber(live.supply, lang)} / {formatNumber(live.cap, lang)}
            </div>
            <div className="bar">
              <span style={{ inlineSize: `${Math.min(soldPct, 100)}%` }} />
            </div>
          </div>
        )}
        <Link href={`/properties/${p.symbol}`} className="btn">
          {t.viewProperty}
        </Link>
      </div>
    </article>
  );
}
