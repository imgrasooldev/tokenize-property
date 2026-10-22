import Link from "next/link";
import { notFound } from "next/navigation";
import { randomUUID } from "node:crypto";
import { AnalystBox } from "@/components/analyst/AnalystBox";
import { BuildingArt } from "@/components/BuildingArt";
import { ScorePanel } from "@/components/catalog/ScorePanel";
import { PriceChart, RentChart } from "@/components/HistoryCharts";
import { InvestForm } from "@/components/InvestForm";
import { BlockHeight } from "@/components/live/Live";
import { OfferingState, RaiseProgress } from "@/components/offering/OfferingParts";
import { PublicPage } from "@/components/Shell";
import { formatNumber, formatPkr, loc } from "@/lib/i18n";
import { fill } from "@/lib/i18n-verify";
import { catalogDict, clabel, pktDate, pktTime } from "@/lib/i18n-catalog";
import { label, offeringDict } from "@/lib/i18n-offering";
import { MAX_HOLDING_TOKENS, MIN_TOKENS } from "@/lib/invest-rules";
import { bpText, formatPaisa } from "@/lib/offering-rules";
import { shortHash } from "@/lib/pulse-view";
import { catalogEntry, priceHistory, rentByMonth } from "@/lib/server/catalog";
import { investorById } from "@/lib/server/db";
import { getDict } from "@/lib/server/lang";
import { holdingOf, registeredOnChain } from "@/lib/server/readmodel";
import { currentInvestorId } from "@/lib/server/session";

export const dynamic = "force-dynamic";

const rs = (paisa: bigint): number => Number(paisa) / 100;

export default async function PropertyPage({ params }: { params: Promise<{ symbol: string }> }) {
  const { symbol: key } = await params;
  // Only catalogue keys (a listed symbol or a visible offering id) are valid; anything else is a 404.
  const e = await catalogEntry(key);
  if (!e) notFound();
  const { lang, t } = await getDict();
  const l = catalogDict(lang);
  const lo = offeringDict(lang);
  const live = e.token;
  const investorId = await currentInvestorId();
  const investor = investorId ? await investorById(investorId) : null;
  const [verified, holding, prices] = await Promise.all([
    investor && live ? registeredOnChain(investor.wallet_address) : Promise.resolve(false),
    investor && live ? holdingOf(investor.wallet_address) : Promise.resolve(null),
    e.symbol ? priceHistory(e.symbol) : Promise.resolve(null),
  ]);
  const room = holding === null ? 0n : MAX_HOLDING_TOKENS - holding;
  const rent = rentByMonth(e.distributions ?? []);
  const issued = live && live.cap > 0n ? Number((live.supply * 10_000n) / live.cap) : null;
  const vsIssueBp =
    e.lastPricePaisa !== null && e.issuePricePaisa !== null && e.issuePricePaisa > 0n
      ? Number(((e.lastPricePaisa - e.issuePricePaisa) * 10_000n) / e.issuePricePaisa)
      : null;
  const facts = e.facts;
  const o = e.offering;
  const docsChain = e.chainDocuments ?? [];
  const now = Date.now();

  return (
    <PublicPage active="properties">
      <main id="main" className="wrap page">
        <p className="crumbs mu">
          <Link href="/properties">{t.navProperties}</Link> / {loc(e.name, lang)}
        </p>
        <div className="detail">
          <div className="stack">
            <div className="hero-art">
              <BuildingArt property={{ key: e.key, art: e.art, name: e.name }} height={320} uid="hero" />
              <div className="tags start">
                <span className={`chip solid ${e.status === "live" || e.status === "open" ? "ok" : e.status === "soon" ? "cy" : "warn"}`}>
                  {(e.status === "live" || e.status === "open") && <span className="dot" aria-hidden="true" />}
                  {clabel(l, "status_", e.status)}
                </span>
                {e.score.score !== null && (
                  <span className="chip cy">
                    {l.scoreTitle} {e.score.score} · {l.scoreRuleBased}
                  </span>
                )}
              </div>
            </div>
            <div className="title-row">
              <div>
                <h1 className="page-title">{loc(e.name, lang)}</h1>
                <div className="mu">
                  {[
                    e.city ? loc(e.city, lang) : e.district,
                    e.province ? label(lo, "province_", e.province, e.province) : null,
                    e.use ? label(lo, "use_", e.use) : null,
                    facts?.coveredAreaSqft ? fill(l.sqft, { n: formatNumber(Math.round(Number(facts.coveredAreaSqft)), lang) }) : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </div>
              </div>
              <span className="sp" />
              {e.symbol && (
                <span className="chip cy mono" dir="ltr">
                  {e.symbol}
                  {live ? ` · ${shortHash(live.address)}` : ""}
                </span>
              )}
            </div>

            <div className="kpis4">
              <div className="card">
                <div className="label">{l.issuePrice}</div>
                <div className="big">{e.issuePricePaisa === null ? "—" : formatPaisa(e.issuePricePaisa, lang)}</div>
                <div className="small mono">
                  {e.lastPricePaisa === null ? (
                    <span className="mu">{l.noTradesShort}</span>
                  ) : (
                    <span className={vsIssueBp !== null && vsIssueBp >= 0 ? "up" : "dn"} dir="ltr">
                      {l.lastTrade} {formatPaisa(e.lastPricePaisa, lang)}
                      {vsIssueBp !== null && ` (${vsIssueBp >= 0 ? "+" : "-"}${bpText(Math.abs(vsIssueBp))}%)`}
                    </span>
                  )}
                </div>
              </div>
              <div className="card">
                <div className="label">{l.trailingYield}</div>
                <div className="big up">{e.yield?.yieldBp ? `${bpText(e.yield.yieldBp)}%` : "—"}</div>
                <div className="small mu">{e.yield ? (e.yield.rentPaisa12m > 0n ? formatPaisa(e.yield.rentPaisa12m, lang) : l.noRent12m) : l.notPublished}</div>
              </div>
              <div className="card">
                <div className="label">{t.occupancy}</div>
                <div className="big">{facts?.occupancy ? clabel(l, "occ_", facts.occupancy) : "—"}</div>
                <div className="small mu">
                  {facts?.leaseCount !== null && facts?.leaseCount !== undefined ? `${l.leases}: ${formatNumber(facts.leaseCount, lang)}` : l.notPublished}
                </div>
              </div>
              <div className="card">
                <div className="label">{live ? t.mintedCap : lo.raisedSoFar}</div>
                <div className="big">
                  {live ? (issued === null ? "—" : `${bpText(issued)}%`) : o ? formatPaisa(o.paidUnits * o.pricePaisa, lang) : "—"}
                </div>
                <div className="bar" style={{ marginBlockStart: 8 }}>
                  <i
                    style={{
                      inlineSize: `${live ? (issued === null ? "0" : bpText(Math.min(issued, 10_000))) : o && o.targetUnits > 0n ? bpText(Number((o.paidUnits * 10_000n) / o.targetUnits)) : "0"}%`,
                    }}
                  />
                </div>
              </div>
            </div>
            <p className="fine">{l.trailingYieldNote}</p>

            <section className="panel" aria-labelledby="hist-h">
              <h2 id="hist-h">{l.priceHistory}</h2>
              {prices && prices.length > 0 ? (
                <>
                  <PriceChart
                    label={l.priceHistory}
                    data={prices.map((p) => ({ time: p.day, value: rs(p.closePaisa) }))}
                    issuePrice={e.issuePricePaisa === null ? null : rs(e.issuePricePaisa)}
                  />
                  <p className="fine">{l.priceHistoryNote}</p>
                </>
              ) : (
                <p className="note">{fill(l.noTradesYet, { p: e.issuePricePaisa === null ? "—" : formatPaisa(e.issuePricePaisa, lang) })}</p>
              )}
              <h3 className="chart-h">
                <span className="vi">▮</span> {l.rentHistory}
              </h3>
              {rent.length > 0 ? (
                <>
                  <RentChart label={l.rentHistory} data={rent.map((r) => ({ time: r.month, value: rs(r.paisa) }))} />
                  <p className="fine">{l.rentHistoryNote}</p>
                </>
              ) : (
                <p className="note">{l.noRentYet}</p>
              )}
            </section>

            <div className="ai-box" id="ai">
              <AnalystBox lang={lang} scope="property" propertyKey={e.key} />
            </div>

            <div className="g2">
              <ScorePanel score={e.score} lang={lang} l={l} />
              <section className="panel" aria-labelledby="docs-h">
                <h2 id="docs-h">{l.documentsTitle}</h2>
                {docsChain.length === 0 && e.documents.length === 0 ? (
                  <p className="note">{l.noDocs}</p>
                ) : (
                  <div className="docs">
                    {docsChain.length > 0 && <h3 className="small mu">{l.docRegistry}</h3>}
                    {docsChain.map((d) => (
                      <div className="doc" key={`c${d.id.toString()}`}>
                        <span className="ic" aria-hidden="true">
                          ▤
                        </span>
                        <div>
                          <b>{clabel(l, "dt_", String(d.docType))}</b> <span className="mu small">#{d.id.toString()}</span>
                          {d.supersededBy !== null && <span className="chip gray">{l.docSuperseded}</span>}
                          <div className="hashline" dir="ltr">
                            sha256 {d.sha256}
                          </div>
                          <div className="fine" dir="ltr">
                            {t.block} #{d.addedBlock.toString()}
                            {d.addedAt ? ` · ${pktDate(d.addedAt.toISOString())}` : ""}
                          </div>
                        </div>
                      </div>
                    ))}
                    {e.documents.length > 0 && <h3 className="small mu">{l.docPublished}</h3>}
                    {e.documents.map((d) => (
                      <div className="doc" key={`p${d.sha256}`}>
                        <span className="ic" aria-hidden="true">
                          ▤
                        </span>
                        <div>
                          <b>{clabel(l, "doc_", d.docType)}</b> {d.verified && <span className="chip ok">{l.docVerifiedSource}</span>}
                          <div className="hashline" dir="ltr">
                            sha256 {d.sha256}
                          </div>
                          <div className="fine">{pktDate(d.uploadedAt)}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                <p className="fine">{l.docsNote}</p>
                <Link href="/verify#file-check" className="btn secondary small">
                  {l.docCheck}
                </Link>
              </section>
            </div>
          </div>

          <aside className="stack sticky">
            {live && e.listed ? (
              <section className="panel">
                <div className="tabs full" role="presentation">
                  <span className="on">{t.invest}</span>
                  <Link href="/market">{t.navMarket}</Link>
                </div>
                <dl className="kv" style={{ marginBlock: "14px" }}>
                  <dt>{l.issuePrice}</dt>
                  <dd className="mono">{formatPkr(e.listed.navPkr, lang)}</dd>
                  <dt>{t.minInvestment}</dt>
                  <dd>{formatPkr(e.listed.navPkr * Number(MIN_TOKENS), lang)}</dd>
                  <dt>{l.holders}</dt>
                  <dd>{e.holders === null ? "—" : formatNumber(e.holders, lang)}</dd>
                </dl>
                <div style={{ display: "grid", gap: 8 }}>
                  {!investor ? (
                    <Link href="/login" className="btn">
                      {t.signInToInvest}
                    </Link>
                  ) : !verified ? (
                    <p className="note">{t.errUnverified}</p>
                  ) : live.paused ? (
                    <p className="note">{t.errPaused}</p>
                  ) : room < MIN_TOKENS ? (
                    <p className="note">{t.errMaxHolding}</p>
                  ) : (
                    <InvestForm
                      t={t}
                      lang={lang}
                      symbol={e.listed.symbol}
                      navPkr={e.listed.navPkr}
                      yieldBp={e.yield?.yieldBp ?? null}
                      pastRentLabel={l.pastRent}
                      pastRentNote={l.pastRentNote}
                      requestId={randomUUID()}
                      maxTokens={Number(room)}
                    />
                  )}
                </div>
              </section>
            ) : o ? (
              <section className="panel" aria-labelledby="off-h">
                <div className="row-between">
                  <h2 id="off-h">{l.offeringPanel}</h2>
                  <OfferingState state={o.state} l={lo} />
                </div>
                <RaiseProgress o={o} l={lo} lang={lang} />
                <dl className="kv" style={{ marginBlock: "14px" }}>
                  <dt>{l.issuePrice}</dt>
                  <dd className="mono">{formatPaisa(o.pricePaisa, lang)}</dd>
                  <dt>{t.minInvestment}</dt>
                  <dd>{formatPaisa(o.pricePaisa * o.minUnits, lang)}</dd>
                  {o.opensAt && (
                    <>
                      <dt>{lo.opens}</dt>
                      <dd dir="ltr">{pktTime(o.opensAt)}</dd>
                    </>
                  )}
                  {o.closesAt && (
                    <>
                      <dt>{lo.closes}</dt>
                      <dd dir="ltr">{pktTime(o.closesAt)}</dd>
                    </>
                  )}
                </dl>
                {o.state === "ready" && o.opensAt && new Date(o.opensAt).getTime() > now && (
                  <p className="note">{fill(l.offeringOpensOn, { d: pktTime(o.opensAt) })}</p>
                )}
                {e.status === "closed" && <p className="note">{l.offeringClosedNote}</p>}
                <Link href={`/offerings/${o.offeringId}`} className={`btn ${e.status === "open" ? "" : "secondary"}`}>
                  {e.status === "open" ? l.offeringViewReserve : l.offeringView}
                </Link>
              </section>
            ) : (
              <section className="panel">
                <p className="note">{t.chainUnavailable}</p>
              </section>
            )}

            <section className="panel">
              <h2>
                {t.onChainNow} {live && <span className="dot" aria-hidden="true" />}
              </h2>
              {live ? (
                <dl className="kv">
                  <dt>{t.tokenContract}</dt>
                  <dd className="mono cy">{live.address}</dd>
                  <dt>{t.tokensIssued}</dt>
                  <dd className="mono">{formatNumber(live.supply, lang)}</dd>
                  <dt>{t.register}</dt>
                  <dd className="mono">{formatNumber(live.cap, lang)}</dd>
                  <dt>{t.trading}</dt>
                  <dd>{live.paused ? <span className="chip red">{t.tradingPaused}</span> : <span className="chip green">{t.tradingLive}</span>}</dd>
                  <dt>{t.lastBlock}</dt>
                  <dd>
                    <BlockHeight lang={lang} />
                  </dd>
                </dl>
              ) : (
                <p className="note">{o ? (o.token ? shortHash(o.token) : t.trusteeReview) : t.chainUnavailable}</p>
              )}
            </section>

            <section className="panel" aria-labelledby="trust-h">
              <h2 id="trust-h">{l.trustTitle}</h2>
              {facts ? (
                <dl className="kv">
                  <dt>{l.trustKind}</dt>
                  <dd>{facts.structureKind ? clabel(l, "kind_", facts.structureKind) : l.notPublished}</dd>
                  <dt>{l.shariahLabel}</dt>
                  <dd>{facts.shariah === null ? l.notPublished : facts.shariah ? l.yes : l.no}</dd>
                  <dt>{l.plannedUnits}</dt>
                  <dd className="mono">{facts.plannedUnits ? formatNumber(BigInt(facts.plannedUnits), lang) : l.notPublished}</dd>
                  <dt>{l.holdingLimit}</dt>
                  <dd className="mono">{facts.maxHoldingUnits ? formatNumber(BigInt(facts.maxHoldingUnits), lang) : l.notPublished}</dd>
                  <dt>{l.trusteeAccepted}</dt>
                  <dd dir="ltr">{facts.trusteeAcceptedAt ? pktDate(facts.trusteeAcceptedAt) : l.notPublished}</dd>
                  <dt>{l.sponsorKyb}</dt>
                  <dd>{facts.sponsorKybApproved ? l.kybApproved : l.kybNotApproved}</dd>
                  <dt>{l.valuationsLabel}</dt>
                  <dd>
                    {facts.valuations > 0 && facts.valuationLowPaisa !== null && facts.valuationHighPaisa !== null
                      ? fill(l.valuationsValue, {
                          n: formatNumber(facts.valuations, lang),
                          x: formatPaisa(facts.valuationLowPaisa, lang),
                          p: formatPaisa(facts.valuationHighPaisa, lang),
                          d: facts.valuedOn ?? "—",
                        })
                      : l.notPublished}
                  </dd>
                  <dt>{l.declaredRent}</dt>
                  <dd>{facts.monthlyRentPaisa === null ? l.notPublished : formatPaisa(facts.monthlyRentPaisa, lang)}</dd>
                </dl>
              ) : live ? (
                <>
                  <h3 className="small mu">{l.trustOnChain}</h3>
                  <dl className="kv">
                    <dt>{l.trustCap}</dt>
                    <dd className="mono">{formatNumber(live.cap, lang)}</dd>
                    <dt>{l.trustPaused}</dt>
                    <dd>{live.paused ? t.tradingPaused : t.tradingLive}</dd>
                  </dl>
                  <p className="fine">{l.trustNoRecord}</p>
                </>
              ) : (
                <p className="note">{l.notPublished}</p>
              )}
            </section>
          </aside>
        </div>
      </main>
    </PublicPage>
  );
}
