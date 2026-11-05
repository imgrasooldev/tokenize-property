"use client";

import { useActionState } from "react";
import { confirmAppOrderAction, type MarketState } from "@/app/actions/market";
import type { Dict, Lang } from "@/lib/i18n";
import { formatPrice } from "@/lib/i18n";

/**
 * Confirms a market order the mobile app asked for (ADR 0018 amendment 3). Only the code is sent:
 * the server reads the order from the request and the website's own checks decide.
 */
export function AppOrderForm({ t, lang, appCode, band, label }: { t: Dict; lang: Lang; appCode: string; band: { min: number; max: number } | null; label: string }) {
  const [state, action, pending] = useActionState<MarketState, FormData>(confirmAppOrderAction, {});
  const errors: Record<NonNullable<MarketState["error"]>, string> = {
    input: t.errOrderInput,
    min: t.errMin,
    maxOrder: t.errMaxHolding,
    band: band ? t.errBand.replace("{min}", formatPrice(band.min, lang)).replace("{max}", formatPrice(band.max, lang)) : t.errOrderInput,
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
    <form action={action} className="form" data-testid="app-order">
      <input type="hidden" name="appCode" value={appCode} />
      {state.error && (
        <div className="alert" role="alert">
          {errors[state.error]}
        </div>
      )}
      <button type="submit" className="btn" disabled={pending}>
        {label}
      </button>
    </form>
  );
}
