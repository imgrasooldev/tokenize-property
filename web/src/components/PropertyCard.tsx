import Link from "next/link";
import { formatNumber, formatPkr, loc, type Dict, type Lang } from "@/lib/i18n";
import { MIN_TOKENS } from "@/lib/invest-rules";
import type { Property } from "@/lib/properties";
import { shortHash } from "@/lib/pulse-view";
import { sampleScore } from "@/lib/sample-ai";
import type { LiveToken } from "@/lib/server/readmodel";
import { BuildingArt } from "./BuildingArt";

export function PropertyCard({ p, live, lang, t }: { p: Property; live: LiveToken | null; lang: Lang; t: Dict }) {
  const soldPct = live && live.cap > 0n ? Number((live.supply * 10_000n) / live.cap) / 100 : 0;
  const ai = sampleScore(p.symbol);
  return (
    <article className="pcard glass">
      <div className="pcard-art">
        <BuildingArt property={p} uid="card" />
        <div className="tags">
          {p.status === "live" && live ? (
            <span className="chip ok solid">
              <span className="dot" aria-hidden="true" />
              {t.liveShort} · {loc(p.city, lang)}
            </span>
          ) : (
            <span className="chip solid">
              {t.comingSoon} · {loc(p.city, lang)}
            </span>
          )}
          {ai && (
            <span className="chip ai" title={t.aiSampleTip}>
              ✦ AI {ai.score} · {t.sampleTag}
            </span>
          )}
        </div>
      </div>
      <div className="cb">
        <h3>
          <Link href={`/properties/${p.symbol}`} className="stretch">
            {loc(p.name, lang)}
          </Link>
        </h3>
        <div className="loc">
          {p.type === "office" ? t.office : t.retail} · {loc(p.tenant, lang)} · <span className="chip sample">{t.sample}</span>
        </div>
        <div className="kv3">
          <div>
            <small>{t.pricePerToken}</small>
            <b>{formatPkr(p.navPkr, lang)}</b>
          </div>
          <div>
            <small>{t.yield}</small>
            <b className="up">{formatNumber(p.yieldPct, lang)}%</b>
          </div>
          <div>
            <small>{t.minShort}</small>
            <b>{formatPkr(p.navPkr * Number(MIN_TOKENS), lang)}</b>
          </div>
        </div>
        {live ? (
          <>
            <div className="row-between meta">
              <span>
                {formatNumber(soldPct, lang)}% {t.registerIssued}
              </span>
              <span>
                {formatNumber(live.cap - live.supply, lang)} {t.left}
              </span>
            </div>
            <div className="bar">
              <i style={{ inlineSize: `${String(Math.min(soldPct, 100))}%` }} />
            </div>
            <div className="hash">
              <span>
                {t.tokenShort} <span className="mono cy" dir="ltr">{shortHash(live.address)}</span>
              </span>
              <span className="up">{t.onChainCheck} ✓</span>
            </div>
          </>
        ) : (
          <>
            <div className="row-between meta">
              <span>{p.status === "live" ? t.chainUnavailable : t.notOnChainYet}</span>
              <span>{t.comingSoon}</span>
            </div>
            <div className="bar">
              <i style={{ inlineSize: "0%" }} />
            </div>
            <div className="hash">
              <span>{t.trusteeReview}</span>
              <span className="am">{t.pending}</span>
            </div>
          </>
        )}
      </div>
    </article>
  );
}
