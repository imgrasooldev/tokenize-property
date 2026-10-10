import { randomUUID } from "node:crypto";
import Link from "next/link";
import { cancelOrderAction } from "@/app/actions/market";
import { MarketLive } from "@/components/MarketLive";
import { OrderPanel } from "@/components/OrderPanel";
import { formatNumber, formatPrice, loc } from "@/lib/i18n";
import { priceBand } from "@/lib/market-rules";
import { PROPERTIES } from "@/lib/properties";
import { investorById } from "@/lib/server/db";
import { getDict } from "@/lib/server/lang";
import { marketSnapshot, nudgeMatcher, ordersOf, positionOf, toView, tradesOf } from "@/lib/server/market";
import { isVerifiedOnChain } from "@/lib/server/onboarding";
import { currentInvestorId } from "@/lib/server/session";

export const dynamic = "force-dynamic";

export default async function MarketPage() {
  const { lang, t } = await getDict();
  const p = PROPERTIES.find((x) => x.status === "live");
  if (!p) return <main className="container narrow">{t.comingSoon}</main>;

  const id = await currentInvestorId();
  const investor = id ? await investorById(id) : null;
  // Picks up anything left crossing or held for review (e.g. after a restart); throttled, non-blocking.
  nudgeMatcher(p.symbol);
  const view = toView(await marketSnapshot(p.symbol));
  const verified = investor ? (await isVerifiedOnChain(investor.wallet_address)) === true : false;
  const [position, orders, trades] = investor
    ? await Promise.all([positionOf(investor, p.symbol), ordersOf(investor.id), tradesOf(investor.id)])
    : [null, [], []];
  const band = priceBand(p.navPkr);
  const rs = (paisa: string | bigint) => Number(paisa) / 100;

  return (
    <main className="container">
      <div className="alert demo" role="note" style={{ marginBlockStart: 18 }}>
        <strong>{t.demo}:</strong> {t.marketDemo}
      </div>
      <h1 style={{ marginBlock: "18px 4px" }}>
        {loc(p.name, lang)} <span className="meta">· {p.symbol}</span>
      </h1>
      <p className="meta">
        {t.navToday}: {formatPrice(p.navPkr, lang)} · {t.bandShort}: {formatPrice(rs(band.min), lang)} – {formatPrice(rs(band.max), lang)}
      </p>

      <div className="detail">
        <div style={{ display: "grid", gap: 20, alignContent: "start", minWidth: 0 }}>
          <MarketLive symbol={p.symbol} nav={p.navPkr} initial={view} t={t} lang={lang} />

          {investor && (
            <section className="panel">
              <h2>{t.myOrders}</h2>
              {orders.length === 0 ? (
                <p className="note">{t.noOrders}</p>
              ) : (
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>{t.side}</th>
                        <th>{t.price}</th>
                        <th>{t.filledOf}</th>
                        <th>{t.status}</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {orders.map((o) => (
                        <tr key={o.id}>
                          <td>
                            <span className={`chip ${o.side === "buy" ? "green" : "red"}`}>{o.side === "buy" ? t.buy : t.sell}</span>
                          </td>
                          <td>{formatPrice(rs(o.price_paisa), lang)}</td>
                          <td>
                            {formatNumber(BigInt(o.filled), lang)} / {formatNumber(BigInt(o.tokens), lang)}
                          </td>
                          <td title={o.note ?? undefined}>
                            {o.status === "open" ? t.orderOpen : o.status === "filled" ? t.orderFilled : t.orderCancelled}
                          </td>
                          <td>
                            {o.status === "open" && (
                              <form action={cancelOrderAction}>
                                <input type="hidden" name="orderId" value={o.id} />
                                <button type="submit" className="btn secondary small">
                                  {t.cancel}
                                </button>
                              </form>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <h2 style={{ marginBlockStart: 18 }}>{t.myTrades}</h2>
              {trades.length === 0 ? (
                <p className="note">{t.noTrades}</p>
              ) : (
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>{t.side}</th>
                        <th>{t.price}</th>
                        <th>{t.tokens}</th>
                        <th>{t.status}</th>
                        <th>{t.onChain}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {trades.map((tr) => (
                        <tr key={tr.id}>
                          <td>{tr.buyer_id === investor.id ? t.bought : t.soldTrade}</td>
                          <td>{formatPrice(rs(tr.price_paisa), lang)}</td>
                          <td>{formatNumber(BigInt(tr.tokens), lang)}</td>
                          <td title={tr.note ?? undefined}>
                            <span className={`chip ${tr.status === "settled" ? "green" : tr.status === "failed" ? "gray" : "amber"}`}>
                              {tr.status === "settled" ? t.tradeSettled : tr.status === "failed" ? t.tradeFailed : t.subReview}
                            </span>
                          </td>
                          <td className="mono">{tr.transfer_tx ? `${tr.transfer_tx.slice(0, 10)}…` : "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          )}
        </div>

        <aside style={{ display: "grid", gap: 20, alignContent: "start", minWidth: 0 }}>
          {!investor ? (
            <section className="panel">
              <p className="note">{t.marketSignIn}</p>
              <Link href="/login" className="btn">
                {t.signInToInvest}
              </Link>
            </section>
          ) : !verified ? (
            <section className="panel">
              <p className="note">{t.errUnverified}</p>
            </section>
          ) : (
            <OrderPanel
              t={t}
              lang={lang}
              symbol={p.symbol}
              nav={p.navPkr}
              band={{ min: rs(band.min), max: rs(band.max) }}
              cash={position ? rs(position.cashPaisa) : 0}
              freeTokens={position?.freeTokens === null || !position ? 0 : Number(position.freeTokens)}
              orderRequestId={randomUUID()}
              topUpRequestId={randomUUID()}
            />
          )}
          <section className="panel">
            <h2>{t.howMarketWorks}</h2>
            <ol className="steps-list numbered">
              <li>{t.mStep1}</li>
              <li>{t.mStep2}</li>
              <li>{t.mStep3}</li>
              <li>{t.mStep4}</li>
            </ol>
          </section>
        </aside>
      </div>
    </main>
  );
}
