import Link from "next/link";
import { formatNumber, loc, type Dict, type Lang } from "@/lib/i18n";
import { fill } from "@/lib/i18n-verify";
import { clabel, type CatalogDict } from "@/lib/i18n-catalog";
import { label, type OfferingDict } from "@/lib/i18n-offering";
import { MIN_TOKENS } from "@/lib/invest-rules";
import { bpText, formatPaisa } from "@/lib/offering-rules";
import { shortHash } from "@/lib/pulse-view";
import type { CatalogEntry } from "@/lib/server/catalog";
import { BuildingArt } from "./BuildingArt";

const TONE: Record<string, string> = { live: "ok", open: "ok", soon: "cy", closed: "gray", unavailable: "warn" };

/** One catalogue property as a card: every figure from records (T-045). */
export function PropertyCard({ e, lang, t, l, lo }: { e: CatalogEntry; lang: Lang; t: Dict; l: CatalogDict; lo: OfferingDict }) {
  const tone = new Map(Object.entries(TONE)).get(e.status) ?? "gray";
  const place = e.city ? loc(e.city, lang) : (e.district ?? "");
  const token = e.token;
  const issuedBp = token && token.cap > 0n ? Number((token.supply * 10_000n) / token.cap) : null;
  const minPaisa = e.issuePricePaisa === null ? null : e.issuePricePaisa * (e.offering ? e.offering.minUnits : MIN_TOKENS);
  return (
    <article className="pcard glass">
      <div className="pcard-art">
        <BuildingArt property={{ key: e.key, art: e.art, name: e.name }} uid="card" />
        <div className="tags">
          <span className={`chip ${tone} solid`}>
            {(e.status === "live" || e.status === "open") && <span className="dot" aria-hidden="true" />}
            {clabel(l, "status_", e.status)}
            {place ? ` · ${place}` : ""}
          </span>
          {e.score.score !== null && (
            <span className="chip cy" title={l.scoreNotAdvice}>
              {l.scoreTitle} {e.score.score}
            </span>
          )}
        </div>
      </div>
      <div className="cb">
        <h3>
          <Link href={e.href} className="stretch">
            {loc(e.name, lang)}
          </Link>
        </h3>
        <div className="loc">
          {e.use ? label(lo, "use_", e.use) : l.notPublished}
          {e.symbol ? ` · ${e.symbol}` : ""}
        </div>
        <div className="kv3">
          <div>
            <small>{l.issuePrice}</small>
            <b>{e.issuePricePaisa === null ? "—" : formatPaisa(e.issuePricePaisa, lang)}</b>
          </div>
          <div>
            <small>{l.trailingYield}</small>
            <b className={e.yield?.yieldBp ? "up" : undefined}>{e.yield?.yieldBp ? `${bpText(e.yield.yieldBp)}%` : "—"}</b>
          </div>
          <div>
            <small>{t.minShort}</small>
            <b>{minPaisa === null ? "—" : formatPaisa(minPaisa, lang)}</b>
          </div>
        </div>
        {token ? (
          <>
            <div className="row-between meta">
              <span>
                {issuedBp === null ? "—" : `${bpText(issuedBp)}%`} {t.registerIssued}
              </span>
              <span>
                {formatNumber(token.cap - token.supply, lang)} {t.left}
              </span>
            </div>
            <div className="bar">
              <i style={{ inlineSize: `${issuedBp === null ? "0" : bpText(Math.min(issuedBp, 10_000))}%` }} />
            </div>
            <div className="hash">
              <span>
                {t.tokenShort}{" "}
                <span className="mono cy" dir="ltr">
                  {shortHash(token.address)}
                </span>
              </span>
              <span className="up">{t.onChainCheck} ✓</span>
            </div>
          </>
        ) : e.offering ? (
          <>
            <div className="row-between meta">
              <span>{label(lo, "st_", e.offering.state)}</span>
              <span>{fill(lo.unitsN, { n: formatNumber(e.offering.availableUnits, lang) })}</span>
            </div>
            <div className="bar">
              <i style={{ inlineSize: `${e.offering.targetUnits > 0n ? bpText(Number((e.offering.paidUnits * 10_000n) / e.offering.targetUnits)) : "0"}%` }} />
            </div>
            <div className="hash">
              <span>{l.offeringPanel}</span>
              <span className="mono di">{e.offering.closesAt ? e.offering.closesAt.slice(0, 10) : "—"}</span>
            </div>
          </>
        ) : (
          <div className="row-between meta">
            <span>{t.chainUnavailable}</span>
          </div>
        )}
      </div>
    </article>
  );
}
