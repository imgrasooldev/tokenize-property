"use client";

import { useActionState, useRef, useState } from "react";
import { requestTransferAction, type RequestState } from "@/app/actions/transfer";
import { formatNumber, type Lang } from "@/lib/i18n";
import { fill } from "@/lib/i18n-verify";
import { tlabel, type TransferDict } from "@/lib/i18n-transfer";
import { formatPaisa } from "@/lib/offering-rules";
import { CONSIDERATIONS, rupeesToPaisa, shortHex, type Consideration } from "@/lib/transfer-rules";
import { AgreementFile } from "./AgreementFile";
import { FormError } from "./FormError";

export interface TokenChoice {
  token: string;
  units: string | null;
  transferable: boolean;
}

/**
 * The seller's transfer request (S-04 T1 on the website): token, units, the buyer's receive code,
 * sale price or the reason for a gift / family transfer, optional explanations and the signed
 * agreement's SHA-256 (computed in the browser; the file is never uploaded). Every field is
 * controlled, so React's form reset after the action does not lose them when a passkey step-up
 * submits the same form again. The database checks everything again.
 */
export function RequestForm({ l, lang, choices, disabled }: { l: TransferDict; lang: Lang; choices: TokenChoice[]; disabled: boolean }) {
  const [state, action, pending] = useActionState<RequestState, FormData>(requestTransferAction, {});
  const formRef = useRef<HTMLFormElement>(null);
  const [token, setToken] = useState(choices.find((c) => c.transferable)?.token ?? choices[0]?.token ?? "");
  const [units, setUnits] = useState("");
  const [code, setCode] = useState("");
  const [consideration, setConsideration] = useState<Consideration>("sale");
  const [price, setPrice] = useState("");
  const [reason, setReason] = useState("");
  const [explanation, setExplanation] = useState("");
  const [holding, setHolding] = useState("");
  const [hash, setHash] = useState("");
  const [confirm, setConfirm] = useState(false);
  const n = /^[1-9][0-9]{0,12}$/.test(units) ? BigInt(units) : 0n;
  const p = rupeesToPaisa(price);
  const sale = consideration === "sale";

  return (
    <form ref={formRef} action={action} className="form" noValidate data-testid="request-form">
      <FormError error={state.error} l={l} form={formRef} />
      <input type="hidden" name="agreementSha256" value={hash} />
      <label>
        {l.reqToken}
        <select
          name="token"
          dir="ltr"
          value={token}
          onChange={(e) => {
            setToken(e.target.value);
          }}
        >
          {choices.map((c) => (
            <option key={c.token} value={c.token}>
              {fill(!c.transferable ? l.reqTokenOther : c.units ? l.reqTokenHeld : l.reqTokenPolicy, { t: shortHex(c.token), n: c.units ? formatNumber(BigInt(c.units), lang) : "" })}
            </option>
          ))}
        </select>
      </label>
      <label>
        {l.reqUnits}
        <input
          name="units"
          inputMode="numeric"
          dir="ltr"
          required
          maxLength={13}
          autoComplete="off"
          value={units}
          onChange={(e) => {
            setUnits(e.target.value.trim());
          }}
        />
      </label>
      <label>
        {l.reqCode}
        <input
          name="buyerCode"
          dir="ltr"
          required
          maxLength={20}
          autoComplete="off"
          spellCheck={false}
          className="mono"
          placeholder="TR-XXXX-XXXX"
          aria-describedby="code-hint"
          value={code}
          onChange={(e) => {
            setCode(e.target.value.toUpperCase());
          }}
        />
        <span className="hint" id="code-hint">
          {l.reqCodeHint}
        </span>
      </label>
      <fieldset className="seg-field">
        <legend>{l.reqConsideration}</legend>
        {CONSIDERATIONS.map((c) => (
          <label key={c} className="check">
            <input
              type="radio"
              name="consideration"
              value={c}
              checked={consideration === c}
              onChange={() => {
                setConsideration(c);
              }}
            />
            <span>{tlabel(l, "con_", c)}</span>
          </label>
        ))}
      </fieldset>
      {sale ? (
        <>
          <label>
            {l.reqPrice}
            <input
              name="price"
              inputMode="decimal"
              dir="ltr"
              required
              maxLength={20}
              autoComplete="off"
              aria-describedby="price-hint"
              value={price}
              onChange={(e) => {
                setPrice(e.target.value.trim());
              }}
            />
            <span className="hint" id="price-hint">
              {l.reqPriceHint}
            </span>
          </label>
          <dl className="kv">
            <dt>{l.reqTotal}</dt>
            <dd>
              <strong data-testid="request-total">{n > 0n && p !== null ? formatPaisa(n * p, lang) : "—"}</strong>
            </dd>
          </dl>
        </>
      ) : (
        <label>
          {l.reqReason}
          <textarea
            name="noPriceReason"
            rows={2}
            maxLength={500}
            aria-describedby="reason-hint"
            value={reason}
            onChange={(e) => {
              setReason(e.target.value);
            }}
          />
          <span className="hint" id="reason-hint">
            {l.reqReasonHint}
          </span>
        </label>
      )}
      <details className="xfer-optional">
        <summary>{l.reqOptional}</summary>
        {sale && (
          <label>
            {l.reqExplanation}
            <textarea
              name="priceExplanation"
              rows={2}
              maxLength={1000}
              value={explanation}
              onChange={(e) => {
                setExplanation(e.target.value);
              }}
            />
          </label>
        )}
        <label>
          {l.reqHolding}
          <textarea
            name="holdingReason"
            rows={2}
            maxLength={500}
            value={holding}
            onChange={(e) => {
              setHolding(e.target.value);
            }}
          />
        </label>
        <span className="hint">{l.reqTextHint}</span>
      </details>
      <AgreementFile l={l} id="agreement-request" hash={hash} onHash={setHash} />
      <label className="check">
        <input
          type="checkbox"
          name="confirm"
          checked={confirm}
          onChange={(e) => {
            setConfirm(e.target.checked);
          }}
        />
        <span>{l.reqConfirm}</span>
      </label>
      <button type="submit" className="btn" disabled={disabled || pending || !confirm || hash === "" || n === 0n || token === ""}>
        {pending ? l.reqBusy : l.reqBtn}
      </button>
    </form>
  );
}
