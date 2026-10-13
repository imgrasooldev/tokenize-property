"use client";

import { useActionState, useState } from "react";
import { reserveAction, type ReserveState } from "@/app/actions/offering";
import type { Lang } from "@/lib/i18n";
import { fill } from "@/lib/i18n-verify";
import { label, type OfferingDict } from "@/lib/i18n-offering";
import { formatPaisa } from "@/lib/offering-rules";

/**
 * Reserve units of a live offering (S-02). The investor accepts the exact document versions shown
 * (their hashes are posted and checked against the approved versions in the database, OF-10).
 * No payment or bank details are entered here.
 */
export function ReserveForm({
  l,
  lang,
  offeringId,
  requestId,
  pricePaisa,
  minUnits,
  maxUnits,
  docEnSha,
  docUrSha,
  riskSha,
}: {
  l: OfferingDict;
  lang: Lang;
  offeringId: string;
  requestId: string;
  pricePaisa: string;
  minUnits: string;
  maxUnits: string;
  docEnSha: string;
  docUrSha: string;
  riskSha: string;
}) {
  const [state, action, pending] = useActionState<ReserveState, FormData>(reserveAction, {});
  const [units, setUnits] = useState(minUnits);
  const [docLang, setDocLang] = useState<Lang>(lang);
  const n = /^[1-9][0-9]{0,12}$/.test(units) ? BigInt(units) : 0n;
  const docSha = docLang === "ur" ? docUrSha : docEnSha;
  const short = (h: string) => `${h.slice(0, 8)}…${h.slice(-6)}`;

  return (
    <form action={action} className="form" noValidate>
      {state.error && (
        <div className="alert" role="alert">
          {label(l, "err_", state.error, l.err_generic)}
        </div>
      )}
      <input type="hidden" name="offeringId" value={offeringId} />
      <input type="hidden" name="requestId" value={requestId} />
      <input type="hidden" name="docSha" value={docSha} />
      <input type="hidden" name="riskSha" value={riskSha} />
      <label>
        {l.units}
        <input
          name="units"
          inputMode="numeric"
          dir="ltr"
          required
          maxLength={13}
          value={units}
          onChange={(e) => {
            setUnits(e.target.value.trim());
          }}
          aria-describedby="units-hint"
        />
        <span className="hint" id="units-hint">
          {fill(l.unitsHint, { n: minUnits, m: maxUnits })}
        </span>
      </label>
      <dl className="kv">
        <dt>{l.youPay}</dt>
        <dd>
          <strong data-testid="you-pay">{n > 0n ? formatPaisa(n * BigInt(pricePaisa), lang) : "—"}</strong>
        </dd>
      </dl>
      <fieldset className="seg-field">
        <legend>{l.docLanguage}</legend>
        <label className="check">
          <input type="radio" name="language" value="en" checked={docLang === "en"} onChange={() => { setDocLang("en"); }} />
          <span>{l.langEn}</span>
        </label>
        <label className="check">
          <input type="radio" name="language" value="ur" checked={docLang === "ur"} onChange={() => { setDocLang("ur"); }} />
          <span lang="ur">{l.langUr}</span>
        </label>
      </fieldset>
      <label className="check">
        <input type="checkbox" name="acceptDoc" required />
        <span>{fill(l.acceptDoc, { h: short(docSha) })}</span>
      </label>
      <label className="check">
        <input type="checkbox" name="acceptRisk" required />
        <span>{fill(l.acceptRisk, { h: short(riskSha) })}</span>
      </label>
      <button type="submit" className="btn" disabled={pending || n === 0n}>
        {pending ? l.reserving : l.reserveBtn}
      </button>
      <p className="hint">{l.reserveNote}</p>
    </form>
  );
}
