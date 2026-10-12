import Link from "next/link";
import { notFound } from "next/navigation";
import { randomUUID } from "node:crypto";
import { BuildingArt } from "@/components/BuildingArt";
import { NavChart, RentChart } from "@/components/HistoryCharts";
import { InvestForm } from "@/components/InvestForm";
import { BlockHeight } from "@/components/live/Live";
import { PublicPage, Sample, Spark } from "@/components/Shell";
import { tokenAbi } from "@/lib/abis";
import { formatNumber, formatPkr, formatPrice, loc } from "@/lib/i18n";
import { MAX_HOLDING_TOKENS, MIN_TOKENS } from "@/lib/invest-rules";
import { findProperty, sampleHistory } from "@/lib/properties";
import { shortHash } from "@/lib/pulse-view";
import { sampleScore } from "@/lib/sample-ai";
import { liveToken } from "@/lib/server/chain";
import { investorById } from "@/lib/server/db";
import { publicClient } from "@/lib/server/demo-signer";
import { getDict } from "@/lib/server/lang";
import { marketSnapshot } from "@/lib/server/market";
import { isVerifiedOnChain } from "@/lib/server/onboarding";
import { currentInvestorId } from "@/lib/server/session";

export const dynamic = "force-dynamic";

export default async function PropertyPage({ params }: { params: Promise<{ symbol: string }> }) {
  const { symbol } = await params;
  // Only catalogue symbols are valid; anything else is a 404 (no user input reaches the chain layer).
  const p = findProperty(symbol);
  if (!p) notFound();
  const { lang, t } = await getDict();
  const live = p.status === "live" ? await liveToken(p.symbol) : null;
  const history = sampleHistory(p);
  const minTokens = Number(MIN_TOKENS);
  const investorId = await currentInvestorId();
  const investor = investorId ? await investorById(investorId) : null;
  const verified = investor ? (await isVerifiedOnChain(investor.wallet_address)) === true : false;
  const holding =
    investor && live
      ? await publicClient
          .readContract({ address: live.address, abi: tokenAbi, functionName: "balanceOf", args: [investor.wallet_address] })
          .catch(() => null)
      : null;
  const room = holding === null ? 0n : MAX_HOLDING_TOKENS - holding;
  const market = live ? await marketSnapshot(p.symbol).catch(() => null) : null;
  const last = market?.last === null || market?.last === undefined ? null : Number(market.last) / 100;
  const vsNav = last === null ? null : ((last - p.navPkr) / p.navPkr) * 100;
  const mintedPct = live && live.cap > 0n ? Number((live.supply * 10_000n) / live.cap) / 100 : null;
  const ai = sampleScore(p.symbol);
  const factorLabel = { tenant: t.fTenant, lease: t.fLease, location: t.fLocation, liquidity: t.fLiquidity, title: t.fTitle } as const;

  return (
    <PublicPage active="properties">
      <main id="main" className="wrap page">
        <p className="crumbs mu">
          <Link href="/properties">{t.navProperties}</Link> / {loc(p.name, lang)}
        </p>
        <div className="detail">
          <div className="stack">
            <div className="hero-art">
              <BuildingArt property={p} height={320} uid="hero" />
              <div className="tags start">
                {live ? (
                  <span className="chip ok solid">
                    <span className="dot" aria-hidden="true" />
                    {t.liveOnChain}
                  </span>
                ) : (
                  <span className="chip solid">{t.comingSoon}</span>
                )}
                {ai && (
                  <span className="chip ai">
                    ✦ AI {ai.score} · {t.sampleTag}
                  </span>
                )}
                <span className="chip warn solid">{t.sample}</span>
              </div>
            </div>
            <div className="title-row">
              <div>
                <h1 className="page-title">{loc(p.name, lang)}</h1>
                <div className="mu">
                  {loc(p.city, lang)} · {p.type === "office" ? t.office : t.retail} · {formatNumber(p.areaSqft, lang)} sq ft
                </div>
              </div>
              <span className="sp" />
              <span className="chip cy mono" dir="ltr">
                {p.symbol}
                {live ? ` · ${shortHash(live.address)}` : ""}
              </span>
            </div>

            <div className="kpis4">
              <div className="card">
                <div className="label">{t.pricePerToken}</div>
                <div className="big">{formatPkr(p.navPkr, lang)}</div>
                <div className="small mono">
                  {last === null ? (
                    <span className="mu">{t.navToday}</span>
                  ) : (
                    <span className={vsNav !== null && vsNav >= 0 ? "up" : "dn"} dir="ltr">
                      {t.lastPrice} {formatPrice(last, lang)} ({vsNav !== null && vsNav >= 0 ? "+" : ""}
                      {vsNav?.toFixed(2)}%)
                    </span>
                  )}
                </div>
              </div>
              <div className="card">
                <div className="label">{t.yield}</div>
                <div className="big up">{formatNumber(p.yieldPct, lang)}%</div>
                <div className="small mu">{t.paidMonthly}</div>
              </div>
              <div className="card">
                <div className="label">{t.occupancy}</div>
                <div className="big">{formatNumber(p.occupancyPct, lang)}%</div>
                <div className="small mu">{loc(p.tenant, lang)}</div>
              </div>
              <div className="card">
                <div className="label">{t.mintedCap}</div>
                <div className="big">{mintedPct === null ? "—" : `${formatNumber(mintedPct, lang)}%`}</div>
                <div className="bar" style={{ marginBlockStart: 8 }}>
                  <i style={{ inlineSize: `${String(Math.min(mintedPct ?? 0, 100))}%` }} />
                </div>
              </div>
            </div>

            <section className="panel">
              <div className="row-between">
                <h2>{t.historyChartTitle}</h2>
                <span className="chip sample">{t.sampleHistory}</span>
              </div>
              <h3 className="chart-h">
                <span className="cy">━</span> {t.navChart}
              </h3>
              <NavChart data={history} />
              <h3 className="chart-h">
                <span className="vi">▮</span> {t.rentChart}
              </h3>
              <RentChart data={history} />
            </section>

            <div className="ai-box" id="ai">
              <div className="hd">
                <span className="orb" aria-hidden="true" />
                {t.analystName} <span className="chip ai">{t.citesNotAdvice}</span>
                <span className="sp" />
                <Sample t={t} />
              </div>
              <div className="q-bubble">{t.aiPropQ}</div>
              <p className="ai-text">
                {t.aiPropA1} <span className="cite">lease §4.2</span> {t.aiPropA2} <span className="cite">trust deed §9</span> {t.aiPropA3}{" "}
                <span className="cite">valuation p.12</span> {t.aiPropA4} <span className="cite">risk §2</span>
              </p>
              <div className="sugg" aria-hidden="true">
                <span>{t.sugg2}</span>
                <span>{t.sugg1}</span>
                <span lang="ur">اردو میں سمجھائیں</span>
              </div>
              <div className="askbox" aria-disabled="true">
                <Spark />
                <span>{t.askProperty}</span>
                <span className="sp" />
                <Sample t={t} soon />
              </div>
            </div>

            <div className="g2">
              {ai && (
                <section className="panel">
                  <div className="row-between">
                    <h2>
                      {t.aiRiskScore} · {ai.score} / 100
                    </h2>
                    <Sample t={t} />
                  </div>
                  <div className="factors">
                    {ai.factors.map((f) => (
                      <div className="factor" key={f.key}>
                        <span>{factorLabel[f.key]}</span>
                        <div className="t">
                          <i style={{ inlineSize: `${String(f.value)}%` }} />
                        </div>
                        <span>{f.value}</span>
                      </div>
                    ))}
                  </div>
                  <p className="fine">{t.scoreDisclaimer}</p>
                </section>
              )}
              <section className="panel">
                <div className="row-between">
                  <h2>{t.documents}</h2>
                  <Sample t={t} soon />
                </div>
                <div className="docs">
                  {[t.docLease, t.docValuation, t.docTrust, t.docTitle].map((d) => (
                    <div className="doc" key={d}>
                      <span className="ic" aria-hidden="true">
                        ▤
                      </span>
                      <div>
                        <b>{d}</b>
                        <div className="di mono small">{t.docHashSoon}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            </div>
          </div>

          <aside className="stack sticky">
            <section className="panel">
              <div className="tabs full" role="presentation">
                <span className="on">{t.invest}</span>
                <Link href="/market">{t.navMarket}</Link>
              </div>
              <dl className="kv" style={{ marginBlock: "14px" }}>
                <dt>{t.pricePerToken}</dt>
                <dd className="mono">{formatPkr(p.navPkr, lang)} (NAV)</dd>
                <dt>{t.minInvestment}</dt>
                <dd>{formatPkr(p.navPkr * minTokens, lang)}</dd>
                <dt>{t.area}</dt>
                <dd>{formatNumber(p.areaSqft, lang)} sq ft</dd>
                <dt>{t.tenant}</dt>
                <dd>{loc(p.tenant, lang)}</dd>
              </dl>
              <div style={{ display: "grid", gap: 8 }}>
                {!live ? (
                  <>
                    <span className="btn secondary" aria-disabled="true">
                      {t.invest}
                    </span>
                    <span className="meta">{p.status === "live" ? t.chainUnavailable : t.comingSoon}</span>
                  </>
                ) : !investor ? (
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
                  <InvestForm t={t} lang={lang} symbol={p.symbol} navPkr={p.navPkr} yieldPct={p.yieldPct} requestId={randomUUID()} maxTokens={Number(room)} />
                )}
              </div>
            </section>

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
                <p className="note">{p.status === "live" ? t.chainUnavailable : t.comingSoon}</p>
              )}
            </section>

            <section className="panel">
              <div className="row-between">
                <h2>{t.trustStructure}</h2>
                <Sample t={t} />
              </div>
              <div className="checks">
                <div className="check">
                  <i>✓</i>
                  {t.trustHeld}
                </div>
                <div className="check">
                  <i>✓</i>
                  {t.trustRegister}
                </div>
                <div className="check">
                  <i className="wait">…</i>
                  {t.trustSecp}
                </div>
              </div>
            </section>
          </aside>
        </div>
      </main>
    </PublicPage>
  );
}
