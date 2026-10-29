import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { randomUUID } from "node:crypto";
import { OfferingState, offeringTitle, RaiseProgress } from "@/components/offering/OfferingParts";
import { ReserveForm } from "@/components/offering/ReserveForm";
import { PublicPage } from "@/components/Shell";
import { formatNumber } from "@/lib/i18n";
import { fill } from "@/lib/i18n-verify";
import { label, offeringDict, type OfferingDict } from "@/lib/i18n-offering";
import { canCancel, formatPaisa, formatPkt, isUuid } from "@/lib/offering-rules";
import { investorById, type InvestorRow } from "@/lib/server/db";
import { getDict } from "@/lib/server/lang";
import { disclosures, mySubscriptions, offeringById, type PublicOffering } from "@/lib/server/offerings";
import { currentInvestorId } from "@/lib/server/session";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Offering · Property Token" };

/**
 * One offering (S-02): terms, raise progress, rules, documents and the reserve panel. Only
 * approved offerings are visible (migration 0018 WO-5); anything else is a 404.
 */
export default async function OfferingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const o = await offeringById(id);
  const discl = o ? await disclosures(o.offeringId) : [];
  if (!o) notFound();
  const { lang } = await getDict();
  const l = offeringDict(lang);
  const investorId = await currentInvestorId();
  const investor = investorId ? await investorById(investorId) : null;
  const open = investor ? (await mySubscriptions(investor)).find((s) => s.offeringId === o.offeringId && (canCancel(s.state) || s.state === "initiated")) : undefined;
  const short = (h: string | null) => (h ? `${h.slice(0, 16)}…${h.slice(-8)}` : "—");
  const total = o.useOfProceeds.reduce((a, x) => a + x.paisa, 0n);

  return (
    <PublicPage active="offerings">
      <main id="main" className="wrap page">
        <p className="crumbs mu">
          <Link href="/offerings">{l.navOfferings}</Link> / {offeringTitle(o, l)}
        </p>
        <div className="detail">
          <div className="stack">
            <div className="title-row">
              <div>
                <h1 className="page-title">{offeringTitle(o, l)}</h1>
                <div className="mu">
                  {o.use ? label(l, "use_", o.use) : ""}
                  {o.coveredAreaSqft ? ` · ${fill(l.sqft, { n: formatNumber(BigInt(o.coveredAreaSqft.split(".")[0] ?? "0"), lang) })}` : ""}
                </div>
              </div>
              <span className="sp" />
              <OfferingState state={o.state} l={l} />
            </div>

            <section className="panel">
              <RaiseProgress o={o} l={l} lang={lang} />
            </section>

            <section className="panel" aria-labelledby="terms-h">
              <h2 id="terms-h">{l.termsTitle}</h2>
              <dl className="kv" data-testid="terms">
                <dt>{l.pricePerToken}</dt>
                <dd>{formatPaisa(o.pricePaisa, lang)}</dd>
                <dt>{l.raiseTarget}</dt>
                <dd>
                  {formatPaisa(o.targetUnits * o.pricePaisa, lang)} · {fill(l.unitsN, { n: formatNumber(o.targetUnits, lang) })}
                </dd>
                <dt>{l.minPerInvestor}</dt>
                <dd>{fill(l.unitsN, { n: formatNumber(o.minUnits, lang) })}</dd>
                <dt>{l.maxPerInvestor}</dt>
                <dd>{fill(l.unitsN, { n: formatNumber(o.maxUnits, lang) })}</dd>
                <dt>{l.available}</dt>
                <dd>{fill(l.unitsN, { n: formatNumber(o.availableUnits, lang) })}</dd>
                {o.waitlistedUnits > 0n && (
                  <>
                    <dt>{l.waitlisted}</dt>
                    <dd>{fill(l.unitsN, { n: formatNumber(o.waitlistedUnits, lang) })}</dd>
                  </>
                )}
                <dt>{l.opens}</dt>
                <dd>{formatPkt(o.opensAt, lang)}</dd>
                <dt>{l.closes}</dt>
                <dd>
                  {formatPkt(o.closesAt, lang)}
                  {o.extended && ` (${l.extended})`}
                </dd>
                <dt>{l.reservationHold}</dt>
                <dd>{fill(l.hoursN, { h: formatNumber(Math.floor(o.reservationMinutes / 60), lang) })}</dd>
                <dt>{l.paymentGrace}</dt>
                <dd>{fill(l.minutesN, { m: formatNumber(o.paymentGraceMinutes, lang) })}</dd>
                <dt>{o.completionDeadline ? l.completionDeadline : l.completionWithin}</dt>
                <dd>{o.completionDeadline ? formatPkt(o.completionDeadline, lang) : fill(l.daysN, { n: formatNumber(o.completionDays, lang) })}</dd>
                <dt>{l.token}</dt>
                <dd className="mono small" dir="ltr">
                  {o.token ?? l.tokenSoon}
                </dd>
              </dl>
              <p className="fine">{l.allTimesPkt}</p>
            </section>

            <section className="panel" aria-labelledby="how-h">
              <h2 id="how-h">{l.howTitle}</h2>
              <ul className="steps-list numbered" data-testid="rules">
                <li>{o.allOrNothing ? l.allOrNothingNote : fill(l.partialNote, { n: formatNumber(o.minRaiseUnits, lang) })}</li>
                <li>{fill(l.fcfsNote, { h: formatNumber(Math.floor(o.reservationMinutes / 60), lang) })}</li>
                <li>{l.mintNote}</li>
                <li>{l.refundNote}</li>
              </ul>
            </section>

            <div className="g2">
              <section className="panel" aria-labelledby="docs-h">
                <h2 id="docs-h">{l.documents}</h2>
                <div className="docs">
                  {(
                    [
                      [l.docEn, o.docEnSha],
                      [l.docUr, o.docUrSha],
                      [l.docRisk, o.riskSha],
                    ] as const
                  ).map(([name, sha]) => (
                    <div className="doc" key={name}>
                      <span className="ic" aria-hidden="true">
                        ▤
                      </span>
                      <div style={{ minInlineSize: 0 }}>
                        <b>{name}</b>
                        <div className="di mono small" dir="ltr" title={sha ?? undefined}>
                          SHA-256 {short(sha)}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
                <p className="fine">{l.docHashNote}</p>
                {discl.length > 0 && (
                  <>
                    <h3 className="small">{l.disclosures}</h3>
                    <ul className="plain" data-testid="disclosures">
                      {discl.map((d) => (
                        <li key={d.sha256}>
                          <b>{d.kind === "supplementary" ? l.discl_supplementary : l.discl_extension}</b> · {formatPkt(d.publishedAt, lang)}{" "}
                          <span className="di mono small" dir="ltr" title={d.sha256}>
                            SHA-256 {short(d.sha256)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
                <p className="fine">
                  <Link href="/verify#sec-docs">{l.verifyLink}</Link> · {l.downloadSoon}
                </p>
              </section>
              {o.useOfProceeds.length > 0 && (
                <section className="panel" aria-labelledby="uop-h">
                  <h2 id="uop-h">{l.useOfProceeds}</h2>
                  <dl className="kv">
                    {o.useOfProceeds.map((u) => (
                      <div key={u.line} style={{ display: "contents" }}>
                        <dt>{label(l, "line_", u.line, u.line.replaceAll("_", " "))}</dt>
                        <dd>{formatPaisa(u.paisa, lang)}</dd>
                      </div>
                    ))}
                    <dt>
                      <b>{l.total}</b>
                    </dt>
                    <dd>
                      <b>{formatPaisa(total, lang)}</b>
                    </dd>
                  </dl>
                </section>
              )}
            </div>
          </div>

          <aside className="stack sticky">
            <section className="panel" aria-labelledby="reserve-h">
              <h2 id="reserve-h">{l.reserveTitle}</h2>
              <ReservePanel o={o} l={l} lang={lang} investor={investor} openSubscription={open?.subscriptionId ?? null} />
            </section>
          </aside>
        </div>
      </main>
    </PublicPage>
  );
}

function ReservePanel({
  o,
  l,
  lang,
  investor,
  openSubscription,
}: {
  o: PublicOffering;
  l: OfferingDict;
  lang: "en" | "ur";
  investor: InvestorRow | null;
  openSubscription: string | null;
}) {
  if (o.state !== "live") return <p className="note">{l.notOpenNow}</p>;
  if (!investor)
    return (
      <Link href="/login" className="btn">
        {l.signIn}
      </Link>
    );
  // KYC gate for the message only; the database refuses anyone not verified (migration 0018 WO-2).
  if (investor.kyc_status !== "verified") return <p className="note">{l.kycNeeded}</p>;
  if (!investor.kyc_subject) return <p className="note">{l.kycRecordMissing}</p>;
  if (openSubscription)
    return (
      <>
        <p className="note">{l.alreadyHave}</p>
        <Link href={`/subscriptions?sub=${openSubscription}`} className="btn secondary">
          {l.viewMine}
        </Link>
      </>
    );
  if (!o.docEnSha || !o.docUrSha || !o.riskSha) return <p className="note">{l.notOpenNow}</p>;
  return (
    <ReserveForm
      l={l}
      lang={lang}
      offeringId={o.offeringId}
      requestId={randomUUID()}
      pricePaisa={o.pricePaisa.toString()}
      minUnits={o.minUnits.toString()}
      maxUnits={o.maxUnits.toString()}
      docEnSha={o.docEnSha}
      docUrSha={o.docUrSha}
      riskSha={o.riskSha}
    />
  );
}
