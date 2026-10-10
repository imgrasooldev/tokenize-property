"use client";

import { useActionState, useState } from "react";
import { invest, type InvestState } from "@/app/actions/invest";
import type { Dict, Lang } from "@/lib/i18n";
import { formatPkr } from "@/lib/i18n";

export function InvestForm({
  t,
  lang,
  symbol,
  navPkr,
  requestId,
  maxTokens,
}: {
  t: Dict;
  lang: Lang;
  symbol: string;
  navPkr: number;
  requestId: string;
  maxTokens: number;
}) {
  const [state, action, pending] = useActionState<InvestState, FormData>(invest, {});
  const [tokens, setTokens] = useState("100");
  const n = /^[1-9][0-9]{0,6}$/.test(tokens) ? Number(tokens) : 0;

  const errors: Record<NonNullable<InvestState["error"]>, string> = {
    input: t.errInvestInput,
    min: t.errMin,
    maxHolding: t.errMaxHolding,
    cap: t.errCap,
    paused: t.errPaused,
    unverified: t.errUnverified,
    notLive: t.errNotLive,
    chain: t.errInvestChain,
    generic: t.errInvestGeneric,
    rate: t.errRate,
  };
  const errorText = state.error ? errors[state.error] : null;

  return (
    <form action={action} className="form" noValidate>
      {errorText && (
        <div className="alert" role="alert">
          {errorText}
        </div>
      )}
      <input type="hidden" name="symbol" value={symbol} />
      <input type="hidden" name="requestId" value={requestId} />
      <label>
        {t.tokensToBuy}
        <input
          name="tokens"
          inputMode="numeric"
          dir="ltr"
          required
          maxLength={7}
          value={tokens}
          onChange={(e) => {
            setTokens(e.target.value.trim());
          }}
          aria-describedby="tokens-hint"
        />
        <span className="hint" id="tokens-hint">
          {t.tokensHint.replace("{max}", maxTokens.toLocaleString(lang === "ur" ? "ur-PK" : "en-PK"))}
        </span>
      </label>
      <dl className="kv">
        <dt>{t.youPay}</dt>
        <dd>
          <strong>{n > 0 ? formatPkr(n * navPkr, lang) : "—"}</strong>
        </dd>
      </dl>
      <div className="raast">
        <div className="raast-head">
          <span className="chip amber">{t.demo}</span> {t.raastTitle}
        </div>
        <p className="hint">{t.raastBody}</p>
        <label className="check">
          <input type="checkbox" name="bankConfirm" />
          <span>{t.raastConfirm}</span>
        </label>
      </div>
      <button type="submit" className="btn" disabled={pending || n === 0}>
        {pending ? t.investing : t.investNow}
      </button>
      <p className="hint">{t.trusteeNote}</p>
    </form>
  );
}
