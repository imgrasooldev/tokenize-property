import Link from "next/link";
import { CountUp, NetCanvas, ReturnsCalc } from "@/components/live/Motion";
import { BlockAge, BlockHeight, BlockRow, TickerStrip, type TickerItem } from "@/components/live/Live";
import { PropertyCard } from "@/components/PropertyCard";
import { PublicPage, Sample, Spark } from "@/components/Shell";
import { formatNumber, formatPkr, formatPrice, loc } from "@/lib/i18n";
import { MIN_TOKENS } from "@/lib/invest-rules";
import { PROPERTIES } from "@/lib/properties";
import { shortHash } from "@/lib/pulse-view";
import { sampleScore } from "@/lib/sample-ai";
import { liveToken } from "@/lib/server/readmodel";
import { getDict } from "@/lib/server/lang";
import { marketSnapshot } from "@/lib/server/market";
import { chainPulse } from "@/lib/server/pulse";
import { siteStats } from "@/lib/server/site-stats";

export const dynamic = "force-dynamic";

const Check = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden="true">
    <path d="M5 12l5 5L20 7" />
  </svg>
);

export default async function Home() {
  const { lang, t } = await getDict();
  const live = await Promise.all(PROPERTIES.map((p) => (p.status === "live" ? liveToken(p.symbol) : Promise.resolve(null))));
  const liveP = PROPERTIES.find((p) => p.status === "live");
  const liveIdx = liveP ? PROPERTIES.indexOf(liveP) : -1;
  const liveT = liveIdx >= 0 ? (live.at(liveIdx) ?? null) : null;
  const [market, stats, pulse] = await Promise.all([
    liveP ? marketSnapshot(liveP.symbol).catch(() => null) : Promise.resolve(null),
    siteStats(),
    chainPulse(),
  ]);
  const last = market?.last === null || market?.last === undefined ? null : Number(market.last) / 100;
  const nav = liveP?.navPkr ?? 0;
  const price = last ?? nav;
  const vsNav = liveP && last !== null ? ((last - nav) / nav) * 100 : null;
  const minPkr = nav * Number(MIN_TOKENS);
  const ai = liveP ? sampleScore(liveP.symbol) : undefined;
  const dist = stats.distributions?.find((d) => d.status !== "rejected") ?? null;
  const rentTotal = stats.distributions?.filter((d) => d.status !== "rejected").reduce((a, d) => a + Number(d.totalPaisa) / 100, 0) ?? null;
  const valueTokenised = liveT && liveP ? Number(liveT.supply) * liveP.navPkr : null;
  const validators = pulse.validators;
  const pct = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;

  const ticker: TickerItem[] = [];
  if (liveP) {
    ticker.push({
      key: "px",
      label: `${liveP.symbol} · ${last === null ? t.navToday : t.lastPrice}`,
      value: formatPrice(price, lang),
      sub: vsNav === null ? undefined : `${pct(vsNav)} ${t.vsNav}`,
      tone: vsNav === null ? undefined : vsNav >= 0 ? "up" : "dn",
    });
  }
  if (liveT) ticker.push({ key: "sup", label: t.tokensIssued, value: formatNumber(liveT.supply, lang), sub: `/ ${formatNumber(liveT.cap, lang)}` });
  if (dist) ticker.push({ key: "rent", label: `${t.rentShort} #${dist.id.toString()}`, value: formatPkr(Number(dist.totalPaisa) / 100, lang), sub: `root ${shortHash(dist.root)}`, tone: "am" });
  if (stats.lastTrade)
    ticker.push({
      key: "trade",
      label: t.tradeSettledDvp,
      value: `${formatNumber(stats.lastTrade.tokens, lang)} ${stats.lastTrade.symbol} @ ${formatPrice(stats.lastTrade.pricePaisa / 100, lang)}`,
      sub: shortHash(stats.lastTrade.tx),
      tone: "cy",
    });
  if (stats.lastMint)
    ticker.push({ key: "mint", label: t.minted, value: `${formatNumber(stats.lastMint.tokens, lang)} ${stats.lastMint.symbol}`, sub: shortHash(stats.lastMint.tx), tone: "up" });
  if (pulse.ledgerOk !== null) ticker.push({ key: "ledger", label: t.ledgerChain, value: pulse.ledgerOk ? t.intact : t.broken, tone: pulse.ledgerOk ? "up" : "dn" });
  if (ai) ticker.push({ key: "ai", label: `✦ ${t.aiRiskScore}`, value: `${String(ai.score)} / 100`, sample: true });

  const factorLabel = { tenant: t.fTenant, lease: t.fLease, location: t.fLocation, liquidity: t.fLiquidity, title: t.fTitle } as const;

  return (
    <PublicPage active="explore">
      <main id="main">
        {/* ---------------------------------------------------------------- hero */}
        <div className="wrap hero">
          <div>
            <span className="chip">
              <span className="dot" aria-hidden="true" />
              {validators === null ? t.heroChipNoVal : t.heroChip.replace("{n}", String(validators))}
            </span>
            <h1 className="hero-title">
              {t.heroLine1}
              <br />
              <span className="grad">{t.heroLine2}</span>
              <br />
              {t.heroLine3}
            </h1>
            <p className="lead">{t.heroLead.replace("{min}", formatPkr(minPkr, lang))}</p>
            <div className="cta">
              <Link className="btn" href="/signup">
                {t.startInvesting} <span aria-hidden="true">{lang === "ur" ? "←" : "→"}</span>
              </Link>
              <Link className="btn secondary" href="/#ai">
                <Spark />
                {t.askAnalyst}
              </Link>
            </div>
            <div className="proofs">
              {[t.proofMerkle, t.proofKyc, t.proofLedger, t.proofRegister].map((s) => (
                <span className="proof" key={s}>
                  <Check />
                  {s}
                </span>
              ))}
            </div>
          </div>

          <div className="netwrap">
            <NetCanvas />
            {liveP && (
              <div className="core glass">
                <div className="ring">
                  <span>{liveP.symbol}</span>
                </div>
                <div className="core-price" dir="ltr">
                  {formatPrice(price, lang)}
                </div>
                <small>
                  {loc(liveP.name, lang)} · {t.navToday} {formatPkr(nav, lang)}
                  {vsNav !== null && (
                    <>
                      {" · "}
                      <span className={vsNav >= 0 ? "up" : "dn"} dir="ltr">
                        {pct(vsNav)}
                      </span>
                    </>
                  )}
                </small>
              </div>
            )}
            {ai && (
              <div className="orbit glass o1">
                <h5>
                  <Spark /> {t.aiRiskScore} <Sample t={t} />
                </h5>
                <b>{ai.score} / 100</b> <span className="mu">{t.lowRisk}</span>
                <div className="bar">
                  <i style={{ inlineSize: `${String(ai.score)}%` }} />
                </div>
              </div>
            )}
            <div className="orbit glass o2">
              <h5>
                <span className="dot" aria-hidden="true" /> {t.blockFinalised}
              </h5>
              <b>
                <BlockHeight lang={lang} />
              </b>
              <div className="mono di small">
                {validators === null ? "" : `${String(validators)}/${String(validators)} ${t.validators} · `}
                <BlockAge suffix={t.ago} />
              </div>
            </div>
            <div className="orbit glass o3">
              <h5>{t.rentOnChain}</h5>
              {dist ? (
                <>
                  <b dir="ltr">{formatPrice(Number(dist.totalPaisa) / 100, lang)}</b>
                  <div className="mono cy small" dir="ltr">
                    root {shortHash(dist.root)} ✓
                  </div>
                </>
              ) : (
                <b className="mu">{t.noRent}</b>
              )}
            </div>
            <div className="orbit glass o4">
              <h5>{t.tradeSettledDvp}</h5>
              {stats.lastTrade ? (
                <>
                  <b dir="ltr">
                    {formatNumber(stats.lastTrade.tokens, lang)} {stats.lastTrade.symbol} @ {formatPrice(stats.lastTrade.pricePaisa / 100, lang)}
                  </b>
                  <div className="mono di small">{t.tokensFirst}</div>
                </>
              ) : (
                <b className="mu">{t.noTrades}</b>
              )}
            </div>
          </div>
        </div>

        {/* ---------------------------------------------------------------- ticker */}
        <TickerStrip
          lang={lang}
          items={ticker}
          labels={{ block: t.block, tx: t.txShort, sample: t.sampleTag, validators: t.validatorsOnline, aria: t.liveTicker }}
        />

        {/* ---------------------------------------------------------------- stats */}
        <div className="wrap">
          <div className="statstrip">
            <div>
              <small>{t.valueTokenised}</small>
              <b>{valueTokenised === null ? "—" : <CountUp value={valueTokenised} lang={lang} kind="pkr" />}</b>
            </div>
            <div>
              <small>{t.verifiedInvestors}</small>
              <b>{stats.verifiedInvestors === null ? "—" : <CountUp value={stats.verifiedInvestors} lang={lang} kind="num" />}</b>
            </div>
            <div>
              <small>{t.rentDistributed}</small>
              <b>{rentTotal === null ? "—" : <CountUp value={rentTotal} lang={lang} kind="pkr" />}</b>
            </div>
            <div>
              <small>
                {t.avgYield} <span className="chip sample">{t.sample}</span>
              </small>
              <b className="up">{liveP ? `${formatNumber(liveP.yieldPct, lang)}%` : "—"}</b>
            </div>
            <div>
              <small>{t.tradesOnChain}</small>
              <b>{stats.tradesSettled === null ? "—" : <CountUp value={stats.tradesSettled} lang={lang} kind="num" />}</b>
            </div>
          </div>
          <p className="fine">{t.statsNote}</p>
        </div>

        {/* ---------------------------------------------------------------- AI analyst (concept) */}
        <section id="ai" className="sec">
          <div className="wrap">
            <div className="sec-h">
              <div>
                <div className="kicker">{"// "}{t.kAi}</div>
                <h2>
                  {t.aiTitle1} <span className="grad">{t.aiTitle2}</span>
                </h2>
              </div>
              <p className="sub">{t.aiSub}</p>
            </div>
            <div className="ai-grid">
              <div className="chat glass">
                <div className="chat-h">
                  <div className="avatar-ai" aria-hidden="true">
                    <Spark />
                  </div>
                  <div>
                    <b className="display">{t.analystName}</b>
                    <div className="mu small">{t.analystSub}</div>
                  </div>
                  <span className="sp" />
                  <Sample t={t} />
                </div>
                <div className="msg me">
                  {t.aiQ}
                </div>
                <div className="msg bot">
                  {t.aiA0}
                  <ul>
                    <li>
                      {t.aiA1} <span className="cite">lease §4.2</span>
                    </li>
                    <li>
                      {t.aiA2} <span className="cite">lease §5.1</span>
                    </li>
                    <li>
                      {t.aiA3} <span className="cite">trust deed §9</span> <span className="cite">valuation p.12</span>
                    </li>
                  </ul>
                  <div style={{ marginBlockStart: 8 }}>
                    {t.aiA4} <span className="cite">dist #2</span>
                    <span className="typing" aria-hidden="true" />
                  </div>
                </div>
                <div className="askbox" aria-disabled="true">
                  <span>{t.askPlaceholder}</span>
                  <span className="btn small" aria-disabled="true">
                    {t.ask}
                  </span>
                  <Sample t={t} soon />
                </div>
                <div className="sugg" aria-hidden="true">
                  <span>{t.sugg1}</span>
                  <span>{t.sugg2}</span>
                  <span lang="ur">اردو میں سمجھائیں</span>
                </div>
                <p className="disc">{t.aiDisclaimer}</p>
              </div>

              {ai && liveP && (
                <div className="score glass">
                  <div className="row-between">
                    <b className="display">
                      {t.aiRiskScore} · {liveP.symbol}
                    </b>
                    <Sample t={t} />
                  </div>
                  <div className="gauge">
                    <svg viewBox="0 0 220 120" width="220" height="120" aria-hidden="true">
                      <defs>
                        <linearGradient id="gauge-g" x1="0" x2="1">
                          <stop stopColor="#FF6B81" />
                          <stop offset=".5" stopColor="#F5C46B" />
                          <stop offset="1" stopColor="#2EF2B5" />
                        </linearGradient>
                      </defs>
                      <path d="M20 110 A90 90 0 0 1 200 110" fill="none" stroke="rgba(255,255,255,.08)" strokeWidth="14" strokeLinecap="round" />
                      <path
                        d="M20 110 A90 90 0 0 1 200 110"
                        fill="none"
                        stroke="url(#gauge-g)"
                        strokeWidth="14"
                        strokeLinecap="round"
                        strokeDasharray="283"
                        strokeDashoffset={Math.round(283 * (1 - ai.score / 100))}
                      />
                    </svg>
                    <b>{ai.score}</b>
                    <small>
                      {t.lowRisk} · {ai.factors.length} {t.factors}
                    </small>
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
                  <p className="disc">{t.scoreDisclaimer}</p>
                </div>
              )}
            </div>
          </div>
        </section>

        {/* ---------------------------------------------------------------- properties */}
        <section id="properties" className="sec pt-sm">
          <div className="wrap">
            <div className="sec-h">
              <div>
                <div className="kicker">{"// "}{t.kProps}</div>
                <h2>
                  {t.propsTitle1} <span className="grad">{t.propsTitle2}</span>
                </h2>
              </div>
              <Link className="btn secondary" href="/properties">
                {t.viewAll}
              </Link>
            </div>
            <div className="cards">
              {PROPERTIES.map((p, i) => (
                <PropertyCard key={p.symbol} p={p} live={live.at(i) ?? null} lang={lang} t={t} />
              ))}
            </div>

            {liveP && (
              <div className="glass teaser">
                <div>
                  <h3 className="display">
                    {t.marketTeaser} <span className="chip warn">{t.demo}</span>
                  </h3>
                  <p className="note">{t.marketTeaserBody}</p>
                </div>
                <div className="stats">
                  <div className="stat">
                    <div className="label">
                      {liveP.symbol} · {t.lastPrice}
                    </div>
                    <div className="value">{last === null ? "—" : formatPrice(last, lang)}</div>
                  </div>
                  <div className="stat">
                    <div className="label">{t.vsNav}</div>
                    <div className={`value ${vsNav === null ? "" : vsNav >= 0 ? "up" : "dn"}`} dir="ltr">
                      {vsNav === null ? "—" : pct(vsNav)}
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
              </div>
            )}
          </div>
        </section>

        {/* ---------------------------------------------------------------- live proof */}
        <section id="proof" className="sec pt-sm">
          <div className="wrap">
            <div className="sec-h">
              <div>
                <div className="kicker">{"// "}{t.kProof}</div>
                <h2>
                  {t.proofTitle1} <span className="grad">{t.proofTitle2}</span>
                </h2>
              </div>
              <p className="sub">{t.proofSub}</p>
            </div>
            <div className="feed">
              <div className="blocks glass">
                <div className="row-between" style={{ marginBlockEnd: 14 }}>
                  <b className="display">{t.blocks}</b>
                  <span className="chip ok">
                    <span className="dot" aria-hidden="true" />
                    {t.streaming}
                  </span>
                </div>
                <BlockRow lang={lang} labels={{ block: t.block, tx: t.txShort, empty: t.chainUnavailable }} />
                <div className="events">
                  {stats.lastTrade && (
                    <div className="ev">
                      <span className="k trade">{t.evTrade}</span>
                      <span>
                        {t.evTradeText
                          .replace("{n}", formatNumber(stats.lastTrade.tokens, lang))
                          .replace("{s}", stats.lastTrade.symbol)
                          .replace("{p}", formatPrice(stats.lastTrade.pricePaisa / 100, lang))}
                      </span>
                      <span className="mono" dir="ltr">
                        {shortHash(stats.lastTrade.tx)}
                      </span>
                    </div>
                  )}
                  {dist && (
                    <div className="ev">
                      <span className="k rent">{t.evRent}</span>
                      <span>{t.evRentText.replace("{id}", dist.id.toString()).replace("{a}", formatPkr(Number(dist.totalPaisa) / 100, lang))}</span>
                      <span className="mono" dir="ltr">
                        {shortHash(dist.root)}
                      </span>
                    </div>
                  )}
                  {stats.lastMint && (
                    <div className="ev">
                      <span className="k mint">{t.evMint}</span>
                      <span>{t.evMintText.replace("{n}", formatNumber(stats.lastMint.tokens, lang)).replace("{s}", stats.lastMint.symbol)}</span>
                      <span className="mono" dir="ltr">
                        {shortHash(stats.lastMint.tx)}
                      </span>
                    </div>
                  )}
                  {!stats.lastTrade && !dist && !stats.lastMint && <p className="note">{t.noEvents}</p>}
                </div>
              </div>
              <div className="verify-card glass">
                <b className="display">{t.oneClickTitle}</b>
                <div className="vstep">
                  <div className="ck" aria-hidden="true">
                    ✓
                  </div>
                  <p>
                    {t.checkStatement}
                    {dist && (
                      <span className="mono" dir="ltr">
                        statementHash = {shortHash(dist.statementHash)}
                      </span>
                    )}
                  </p>
                </div>
                <div className="vstep">
                  <div className="ck" aria-hidden="true">
                    ✓
                  </div>
                  <p>
                    {t.checkProof}
                    <span className="mono">{t.merkleProofLine}</span>
                  </p>
                </div>
                <div className="vstep">
                  <div className="ck" aria-hidden="true">
                    ✓
                  </div>
                  <p>
                    {t.checkTamper}
                    <span className="mono">{t.tamperLine}</span>
                  </p>
                </div>
                <div className="vstep">
                  <div className="ck" aria-hidden="true">
                    ✓
                  </div>
                  <p>
                    {t.reconShort}
                    <span className="mono">{t.reconLine}</span>
                  </p>
                </div>
                <p className="fine">{t.oneClickNote}</p>
              </div>
            </div>
          </div>
        </section>

        {/* ---------------------------------------------------------------- proof of rent + returns */}
        <section id="returns" className="sec pt-sm">
          <div className="wrap proof-grid">
            <div className="merkle glass">
              <div className="kicker">{"// "}{t.kRent}</div>
              <h3 className="display h3big">{t.rentProvenTitle}</h3>
              <p className="mu">{t.rentProvenBody}</p>
              <svg viewBox="0 0 520 230" width="100%" height="230" style={{ marginBlockStart: 12 }} role="img" aria-label={t.merkleRoot}>
                <g stroke="#22E3F0" strokeOpacity=".5" fill="none">
                  <path d="M260 40 L150 105M260 40 L370 105M150 105 L95 170M150 105 L205 170M370 105 L315 170M370 105 L425 170" />
                </g>
                <g fontFamily="var(--font-mono), monospace" fontSize="11" textAnchor="middle">
                  <rect x="190" y="20" width="140" height="36" rx="10" fill="#1B1347" stroke="#8B5CF6" />
                  <text x="260" y="43" fill="#E8EEF9">
                    root {dist ? shortHash(dist.root) : "—"}
                  </text>
                  <rect x="95" y="88" width="110" height="34" rx="10" fill="#0D1838" stroke="#22E3F0" />
                  <text x="150" y="110" fill="#8B97AD">
                    hash
                  </text>
                  <rect x="315" y="88" width="110" height="34" rx="10" fill="#0D1838" stroke="#22E3F0" strokeOpacity=".4" />
                  <text x="370" y="110" fill="#5F6B82">
                    hash
                  </text>
                  <rect x="45" y="154" width="100" height="40" rx="10" fill="rgba(46,242,181,.12)" stroke="#2EF2B5" />
                  <text x="95" y="172" fill="#2EF2B5">
                    {t.youLeaf}
                  </text>
                  <text x="95" y="186" fill="#2EF2B5">
                    {t.yourShareLeaf}
                  </text>
                  <rect x="155" y="154" width="100" height="40" rx="10" fill="#0D1838" stroke="#22E3F0" />
                  <text x="205" y="178" fill="#8B97AD">
                    leaf
                  </text>
                  <rect x="265" y="154" width="100" height="40" rx="10" fill="#0D1838" stroke="#22E3F0" strokeOpacity=".3" />
                  <text x="315" y="178" fill="#5F6B82">
                    leaf
                  </text>
                  <rect x="375" y="154" width="100" height="40" rx="10" fill="#0D1838" stroke="#22E3F0" strokeOpacity=".3" />
                  <text x="425" y="178" fill="#5F6B82">
                    leaf
                  </text>
                </g>
              </svg>
              <p className="fine">{dist ? t.merkleLatest.replace("{id}", dist.id.toString()) : t.noRent}</p>
              <Link className="btn" href="/portfolio#rent" style={{ marginBlockStart: 10 }}>
                {t.verifyMyRent} ✓
              </Link>
            </div>
            {liveP && (
              <div className="glass calc-card">
                <div className="kicker">{"// "}{t.kReturns}</div>
                <ReturnsCalc
                  lang={lang}
                  nav={nav}
                  yieldPct={liveP.yieldPct}
                  min={minPkr}
                  l={{
                    invest: t.youInvest,
                    amount: t.investAmount,
                    monthly: t.monthlyRent,
                    yearly: t.yearlyRent,
                    tokens: t.tokens,
                    fiveYear: t.fiveYearRent,
                    note: t.calcNote.replace("{s}", liveP.symbol).replace("{y}", formatNumber(liveP.yieldPct, lang)).replace("{p}", formatPkr(nav, lang)),
                  }}
                />
              </div>
            )}
          </div>
        </section>

        {/* ---------------------------------------------------------------- how it works */}
        <section id="how" className="sec pt-sm">
          <div className="wrap">
            <div className="sec-h">
              <div>
                <div className="kicker">{"// "}{t.kHow}</div>
                <h2>
                  {t.howTitle1} <span className="grad">{t.howTitle2}</span>
                </h2>
              </div>
            </div>
            <div className="pipe">
              <div className="dotrun" aria-hidden="true" />
              {[
                { ic: "◉", h: t.pVerify, p: t.pVerifyB, c: "identity.isVerified" },
                { ic: "⇄", h: t.pPay, p: t.pPayB, c: "ledger.subscription_paid" },
                { ic: "⬡", h: t.pMint, p: t.pMintB, c: "IssuanceGuard.mint()" },
                { ic: "◧", h: t.pHold, p: t.pHoldB, c: "balanceOf(you)" },
                { ic: "₨", h: t.pEarn, p: t.pEarnB, c: "Distribution.verify()" },
              ].map((s) => (
                <div className="ps" key={s.h}>
                  <div className="ic" aria-hidden="true">
                    {s.ic}
                  </div>
                  <h4>{s.h}</h4>
                  <p>{s.p}</p>
                  <code dir="ltr">{s.c}</code>
                </div>
              ))}
            </div>
            <h3 className="display how-sub">
              {t.fourSteps1} <span className="grad">{t.fourSteps2}</span>
            </h3>
            <div className="how">
              <div className="hstep glass">
                <div className="ic" aria-hidden="true">
                  ◉
                </div>
                <h4>{t.hVerify}</h4>
                <p>{t.hVerifyB}</p>
                <div className="tech">ONCHAINID · KYC claims</div>
              </div>
              <div className="hstep glass">
                <div className="ic" aria-hidden="true">
                  <Spark />
                </div>
                <h4>
                  {t.hAi} <Sample t={t} soon />
                </h4>
                <p>{t.hAiB}</p>
                <div className="tech">RAG · cited sources</div>
              </div>
              <div className="hstep glass">
                <div className="ic" aria-hidden="true">
                  ⇄
                </div>
                <h4>{t.hPay}</h4>
                <p>{t.hPayB}</p>
                <div className="tech">ledger · single-use refId mint</div>
              </div>
              <div className="hstep glass">
                <div className="ic" aria-hidden="true">
                  ✓
                </div>
                <h4>{t.hEarn}</h4>
                <p>{t.hEarnB}</p>
                <div className="tech">Merkle proofs · ERC-3643</div>
              </div>
            </div>
          </div>
        </section>

        {/* ---------------------------------------------------------------- final call to action */}
        <div className="final">
          <div className="wrap">
            <div className="kicker">{"// "}{t.kStart}</div>
            <h2>
              {t.finalTitle1}
              <br />
              <span className="grad">{t.finalTitle2.replace("{min}", formatPkr(minPkr, lang))}</span>
            </h2>
            <div className="cta center">
              <Link className="btn" href="/signup">
                {t.createAccount} <span aria-hidden="true">{lang === "ur" ? "←" : "→"}</span>
              </Link>
              <Link className="btn secondary" href="/#ai">
                <Spark /> {t.askAiFirst}
              </Link>
            </div>
          </div>
        </div>
      </main>
    </PublicPage>
  );
}
