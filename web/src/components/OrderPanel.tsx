"use client";

import { useActionState, useState } from "react";
import { placeOrderAction, topUpAction, type MarketState } from "@/app/actions/market";
import type { Dict, Lang } from "@/lib/i18n";
import { formatPkr, formatPrice } from "@/lib/i18n";
import { parseRupees } from "@/lib/market-rules";

export function OrderPanel({
  t,
  lang,
  symbol,
  nav,
  band,
  cash,
  freeTokens,
  orderRequestId,
  topUpRequestId,
}: {
  t: Dict;
  lang: Lang;
  symbol: string;
  nav: number;
  band: { min: number; max: number };
  cash: number;
  freeTokens: number;
  orderRequestId: string;
  topUpRequestId: string;
}) {
  const [state, action, pending] = useActionState<MarketState, FormData>(placeOrderAction, {});
  const [topState, topAction, topPending] = useActionState<MarketState, FormData>(topUpAction, {});
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [price, setPrice] = useState(String(nav));
  const [tokens, setTokens] = useState("100");
  const paisa = parseRupees(price);
  const p = paisa === null ? 0 : Number(paisa) / 100;
  const n = /^[1-9][0-9]{0,5}$/.test(tokens) ? Number(tokens) : 0;

  const errors: Record<NonNullable<MarketState["error"]>, string> = {
    input: t.errOrderInput,
    min: t.errMin,
    maxOrder: t.errMaxHolding,
    band: t.errBand.replace("{min}", formatPrice(band.min, lang)).replace("{max}", formatPrice(band.max, lang)),
    maxHolding: t.errMaxHolding,
    noTokens: t.errNoTokens,
    noCash: t.errNoCash,
    selfTrade: t.errSelfTrade,
    unverified: t.errUnverified,
    notLive: t.errNotLive,
    paused: t.errPaused,
    chain: t.errInvestChain,
    generic: t.errInvestGeneric,
    rate: t.errRate,
  };

  return (
    <div style={{ display: "grid", gap: 20, minWidth: 0 }}>
      <section className="panel">
        <div className="seg" role="group" aria-label={t.side}>
          <button type="button" aria-pressed={side === "buy"} className={side === "buy" ? "on buy" : ""} onClick={() => {
              setSide("buy");
            }}>
            {t.buy}
          </button>
          <button type="button" aria-pressed={side === "sell"} className={side === "sell" ? "on sell" : ""} onClick={() => {
              setSide("sell");
            }}>
            {t.sell}
          </button>
        </div>
        <form action={action} className="form" noValidate style={{ marginBlockStart: 14 }}>
          {state.error && (
            <div className="alert" role="alert">
              {errors[state.error]}
            </div>
          )}
          {state.ok && (
            <div className="alert ok" role="status">
              {t.orderPlaced}
            </div>
          )}
          <input type="hidden" name="symbol" value={symbol} />
          <input type="hidden" name="side" value={side} />
          <input type="hidden" name="requestId" value={orderRequestId} />
          <label>
            {t.limitPrice}
            <input name="price" inputMode="decimal" dir="ltr" value={price} onChange={(e) => {
              setPrice(e.target.value.trim());
            }} maxLength={10} aria-describedby="band-hint" />
            <span className="hint" id="band-hint">
              {t.bandHint.replace("{min}", formatPrice(band.min, lang)).replace("{max}", formatPrice(band.max, lang))}
            </span>
          </label>
          <label>
            {t.tokensToBuy}
            <input name="tokens" inputMode="numeric" dir="ltr" value={tokens} onChange={(e) => {
              setTokens(e.target.value.trim());
            }} maxLength={6} />
          </label>
          <dl className="kv">
            <dt>{side === "buy" ? t.youPay : t.youReceive}</dt>
            <dd>{p > 0 && n > 0 ? formatPrice(p * n, lang) : "—"}</dd>
            <dt>{side === "buy" ? t.cashAvailable : t.tokensAvailable}</dt>
            <dd>{side === "buy" ? formatPrice(cash, lang) : freeTokens.toLocaleString(lang === "ur" ? "ur-PK" : "en-PK")}</dd>
          </dl>
          <button type="submit" className={`btn ${side === "sell" ? "sell" : ""}`} disabled={pending || p === 0 || n === 0}>
            {pending ? t.matching : side === "buy" ? t.placeBuy : t.placeSell}
          </button>
          <p className="hint">{t.dvpNote}</p>
        </form>
      </section>

      <section className="panel">
        <h2>{t.cashTitle}</h2>
        <p className="note">{t.cashNote}</p>
        <form action={topAction} className="form" noValidate>
          {topState.error && (
            <div className="alert" role="alert">
              {topState.error === "input" ? t.errTopUp : topState.error === "rate" ? t.errRate : t.errInvestGeneric}
            </div>
          )}
          <input type="hidden" name="requestId" value={topUpRequestId} />
          <label>
            {t.topUpAmount}
            <input name="amount" inputMode="numeric" dir="ltr" defaultValue="1000000" maxLength={8} />
            <span className="hint">{t.topUpHint.replace("{max}", formatPkr(10_000_000, lang))}</span>
          </label>
          <label className="check">
            <input type="checkbox" name="bankConfirm" />
            <span>{t.raastConfirm}</span>
          </label>
          <button type="submit" className="btn secondary" disabled={topPending}>
            {topPending ? t.processing : t.topUp}
          </button>
        </form>
      </section>
    </div>
  );
}
