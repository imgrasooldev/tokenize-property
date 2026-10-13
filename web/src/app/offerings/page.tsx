import type { Metadata } from "next";
import Link from "next/link";
import { OfferingState, offeringTitle, RaiseProgress } from "@/components/offering/OfferingParts";
import { PublicPage } from "@/components/Shell";
import { formatNumber } from "@/lib/i18n";
import { fill } from "@/lib/i18n-verify";
import { label, offeringDict } from "@/lib/i18n-offering";
import { formatPaisa, formatPkt } from "@/lib/offering-rules";
import { getDict } from "@/lib/server/lang";
import { logError } from "@/lib/server/log";
import { listOfferings, type PublicOffering } from "@/lib/server/offerings";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Offerings · Property Token" };

/** Offerings an investor may see (approved and later), from the offering backend (S-02, migration 0018). */
export default async function OfferingsPage() {
  const { lang } = await getDict();
  const l = offeringDict(lang);
  let offerings: PublicOffering[] | null;
  try {
    offerings = await listOfferings();
  } catch (e) {
    logError("offerings", e);
    offerings = null;
  }

  return (
    <PublicPage active="offerings">
      <main id="main" className="wrap page">
        <div className="kicker">
          {"// "}
          {l.kicker}
        </div>
        <h1 className="page-title">{l.title}</h1>
        <p className="lead-sm meta">{l.intro}</p>
        <p className="fine">{l.allTimesPkt}</p>

        {offerings === null ? (
          <p className="note">{l.err_generic}</p>
        ) : offerings.length === 0 ? (
          <p className="note" data-testid="offerings-none">
            {l.none}
          </p>
        ) : (
          <ul className="offer-grid" data-testid="offerings">
            {offerings.map((o) => (
              <li key={o.offeringId} className="panel offer-card">
                <div className="row-between">
                  <h2 className="offer-title">{offeringTitle(o, l)}</h2>
                  <OfferingState state={o.state} l={l} />
                </div>
                <div className="offer-tags">
                  {o.use && <span className="chip gray">{label(l, "use_", o.use)}</span>}
                  {o.allOrNothing && <span className="chip cy">{l.allOrNothing}</span>}
                </div>
                <dl className="kv">
                  <dt>{l.pricePerToken}</dt>
                  <dd>{formatPaisa(o.pricePaisa, lang)}</dd>
                  <dt>{l.minPerInvestor}</dt>
                  <dd>{fill(l.unitsN, { n: formatNumber(o.minUnits, lang) })}</dd>
                  <dt>{l.maxPerInvestor}</dt>
                  <dd>{fill(l.unitsN, { n: formatNumber(o.maxUnits, lang) })}</dd>
                  <dt>{l.opens}</dt>
                  <dd>{formatPkt(o.opensAt, lang)}</dd>
                  <dt>{l.closes}</dt>
                  <dd>
                    {formatPkt(o.closesAt, lang)}
                    {o.extended && ` (${l.extended})`}
                  </dd>
                </dl>
                <RaiseProgress o={o} l={l} lang={lang} />
                <Link href={`/offerings/${o.offeringId}`} className="btn secondary">
                  {l.viewOffering}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </main>
    </PublicPage>
  );
}
